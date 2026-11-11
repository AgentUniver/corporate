-- Migration: 20261022000000_harden_t1_t0_governance.sql
-- Description: Forward migration hardening RLS INSERT policies against T+1 injection, enforcing dispute window in clawback, ensuring delivery trigger overwrites, and definitive ACL revocation

-- =========================================================================
-- Phase 1: Tighten RLS INSERT Policy on agent_tasks (INV-AUTH P0-BLOCK-01)
-- =========================================================================
ALTER TABLE agent_tasks ALTER COLUMN "settlementType" DROP DEFAULT;

DROP POLICY IF EXISTS "Clients can insert new orders" ON agent_tasks;
CREATE POLICY "Clients can insert new orders" ON agent_tasks
FOR INSERT TO anon, authenticated
WITH CHECK (
    status IN ('pending', 'escrowed')
    AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed'))
    AND ("taskToken" IS NULL OR ("taskToken" ~ '^tok_[a-zA-Z0-9]{16,64}$' AND length("taskToken") >= 20))
    AND "actualCostUsd" IS NULL
    AND "payoutAddress" IS NULL
    AND "payoutTxHash" IS NULL
    AND "deliverableFingerprint" IS NULL
    AND "arbitrationVerdict" IS NULL
    AND "resultPayload" IS NULL
    AND "acceptedByCustomerAt" IS NULL
    AND "t1ReleaseAt" IS NULL
    AND "disputeDeadlineAt" IS NULL
    AND "settlementType" IS NULL
    AND (
        (auth.role() = 'authenticated' AND auth.jwt() ->> 'email' IS NOT NULL AND "userEmail" = (auth.jwt() ->> 'email'))
        OR
        (auth.role() = 'anon' AND "userEmail" IS NULL)
    )
);

GRANT SELECT, INSERT ON TABLE agent_tasks TO anon, authenticated;

-- =========================================================================
-- Phase 2: Monotonic Trigger with Force Overwrite on Delivery (INV-FIN / INV-AUTH)
-- =========================================================================
CREATE OR REPLACE FUNCTION trg_agent_tasks_monotonic_version()
RETURNS TRIGGER AS $$
DECLARE
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- 1. Monotonic version fencing
    IF NEW.version IS NULL OR (OLD.version IS NOT NULL AND NEW.version <= OLD.version) THEN
        RAISE EXCEPTION 'Monotonic version violation: NEW.version (%) must be strictly greater than OLD.version (%)', NEW.version, OLD.version;
    END IF;

    -- 2. State transition whitelist
    IF OLD.status != NEW.status THEN
        IF OLD.status = 'pending' AND NEW.status IN ('escrowed', 'cancelled') THEN
            NULL;
        ELSIF OLD.status = 'escrowed' AND NEW.status IN ('processing', 'cancelled', 'refunded') THEN
            NULL;
        ELSIF OLD.status = 'processing' AND NEW.status IN ('delivered', 'failed') THEN
            NULL;
        ELSIF OLD.status = 'failed' AND NEW.status IN ('refunded', 'cancelled') THEN
            NULL;
        ELSIF OLD.status IN ('delivered', 'disputed') AND NEW.status IN ('completed', 'verified', 'refunded', 'disputed') THEN
            NULL;
        ELSIF OLD.status = 'completed' AND NEW.status IN ('verified', 'refunded', 'disputed') THEN
            NULL;
        ELSIF OLD.status = 'verified' AND NEW.status = 'disputed' THEN
            NULL;
        ELSE
            RAISE EXCEPTION 'illegal transition % -> %', OLD.status, NEW.status;
        END IF;
    END IF;

    -- 3. Settlement immutability with controlled exception for clawback
    IF OLD."payoutStatus" = 'settled' AND NEW."payoutStatus" IS DISTINCT FROM 'settled' THEN
        IF NEW."payoutStatus" != 'clawed_back' THEN
            RAISE EXCEPTION 'settled immutable: cannot transition payoutStatus from settled to %', NEW."payoutStatus";
        END IF;
    END IF;

    IF OLD."payoutStatus" = 'settled' AND NEW."payoutStatus" = 'settled' THEN
        IF NEW.status IN ('refunded', 'pending', 'escrowed', 'processing') THEN
            RAISE EXCEPTION 'settled status frozen: cannot regress verified/settled task status to %', NEW.status;
        END IF;
    END IF;

    -- 4. Mandatory overwrite of T+1 hold on delivery (never inherit client pre-set values)
    IF NEW.status = 'delivered' AND (OLD.status IS DISTINCT FROM 'delivered') THEN
        NEW."t1ReleaseAt" := v_now + INTERVAL '24 hours';
        NEW."disputeDeadlineAt" := v_now + INTERVAL '24 hours';
        NEW."settlementType" := COALESCE(NEW."settlementType", 't1_default');
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Backfill existing unverified delivered/completed tasks lacking t1ReleaseAt
UPDATE agent_tasks
   SET "t1ReleaseAt" = COALESCE("updatedAt", "createdAt", clock_timestamp()) + INTERVAL '24 hours',
       "disputeDeadlineAt" = COALESCE("disputeDeadlineAt", COALESCE("updatedAt", "createdAt", clock_timestamp()) + INTERVAL '24 hours'),
       "settlementType" = COALESCE("settlementType", 't1_default'),
       version = COALESCE(version, 0) + 1
 WHERE status IN ('delivered', 'completed')
   AND "payoutStatus" IS DISTINCT FROM 'settled'
   AND "t1ReleaseAt" IS NULL;

-- =========================================================================
-- Phase 3: Settle Task Function Without Leaking Pre-Set Client Timestamps
-- =========================================================================
DROP FUNCTION IF EXISTS acp_settle_task(TEXT, INTEGER, NUMERIC);

CREATE OR REPLACE FUNCTION acp_settle_task(
    p_task_id TEXT,
    p_expected_version INTEGER,
    p_amount NUMERIC DEFAULT NULL,
    p_customer_accepted BOOLEAN DEFAULT FALSE
)
RETURNS JSONB AS $$
DECLARE
    v_old_status TEXT;
    v_old_payout TEXT;
    v_old_ver INTEGER;
    v_budget_usd NUMERIC;
    v_actual_amount NUMERIC;
    v_next_ver INTEGER;
    v_t1_release TIMESTAMPTZ;
    v_accepted_at TIMESTAMPTZ;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- 1. Lock row
    SELECT status, "payoutStatus", version, "budgetUsd", "t1ReleaseAt", "acceptedByCustomerAt"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd, v_t1_release, v_accepted_at
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_TASK_NOT_FOUND', 'message', 'Task not found');
    END IF;

    -- 2. Idempotent return if already verified and settled
    IF v_old_status = 'verified' AND v_old_payout = 'settled' THEN
        RETURN jsonb_build_object('success', true, 'code', 'ALREADY_SETTLED', 'idempotent', true);
    END IF;

    -- 3. Version CAS check
    IF v_old_ver != p_expected_version THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_VERSION_CONFLICT', 'message', 'Version conflict');
    END IF;

    -- 4. Status eligibility check
    IF v_old_status NOT IN ('delivered', 'completed') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_SETTLEMENT_STATE', 'message', 'Cannot settle in status: ' || COALESCE(v_old_status, 'NULL'));
    END IF;

    -- 5. PayoutStatus eligibility check
    IF v_old_payout = 'settled' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_ALREADY_SETTLED', 'message', 'Payout already settled');
    END IF;
    IF v_old_payout = 'refunded' OR v_old_status = 'refunded' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds have been refunded, settlement rejected');
    END IF;

    -- 6. Check existing refund in payout_ledger
    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds have been refunded, settlement rejected');
    END IF;

    -- 6b. Check existing settle in payout_ledger on unverified task (INV-FIN)
    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_STALE_LEDGER_CONFLICT', 'message', 'Settle ledger already exists for unverified task');
    END IF;

    -- 7. T+1 Hold / Customer Acceptance Boundary Check (Authoritative DB Time)
    -- Security Fix: Only explicit p_customer_accepted = TRUE passed into RPC counts as acceptance
    -- Disregard any pre-set row values for acceptedByCustomerAt when p_customer_accepted is FALSE
    IF p_customer_accepted THEN
        v_accepted_at := v_now;
    ELSE
        IF v_t1_release IS NULL OR v_now < v_t1_release THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'ACP_T1_HOLD_ACTIVE',
                'message', 'Settlement is protected under T+1 hold until ' || COALESCE(v_t1_release::text, 'expiration'),
                't1_release_at', v_t1_release
            );
        END IF;
    END IF;

    -- 8. Enforce authoritative amount from locked row
    IF v_budget_usd IS NULL OR v_budget_usd <= 0 THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_BUDGET', 'message', 'Task lacks authoritative budgetUsd');
    END IF;
    v_actual_amount := v_budget_usd;

    -- 9. Atomic CAS Update
    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'verified',
           "payoutStatus" = 'settled',
           "acceptedByCustomerAt" = COALESCE(v_accepted_at, "acceptedByCustomerAt", v_now),
           version = v_next_ver,
           "updatedAt" = v_now
     WHERE id = p_task_id;

    -- 10. Insert into payout_ledger
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES (p_task_id, 'settle', v_actual_amount);

    -- 11. Insert into agent_task_ledger
    INSERT INTO agent_task_ledger ("taskId", "eventType", "amountUsd", version)
    VALUES (p_task_id, 'payout', v_actual_amount, v_next_ver);

    RETURN jsonb_build_object('success', true, 'code', 'SETTLED', 'version', v_next_ver, 'amount', v_actual_amount);
EXCEPTION
    WHEN unique_violation THEN
        IF v_old_status = 'verified' AND v_old_payout = 'settled' AND EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
            RETURN jsonb_build_object('success', true, 'code', 'ALREADY_SETTLED', 'idempotent', true);
        ELSIF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
            RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds have been refunded, settlement rejected');
        ELSE
            RETURN jsonb_build_object('success', false, 'code', 'ACP_UNIQUE_VIOLATION', 'message', 'Ledger unique constraint violation');
        END IF;
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_DB_ERROR', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- =========================================================================
-- Phase 4: Clawback Task Function with Dispute Window Expiration Check (INV-FIN)
-- =========================================================================
CREATE OR REPLACE FUNCTION acp_clawback_task(
    p_task_id TEXT,
    p_expected_version INTEGER,
    p_reason TEXT DEFAULT 'Customer rejected deliverable within dispute window'
)
RETURNS JSONB AS $$
DECLARE
    v_old_status TEXT;
    v_old_payout TEXT;
    v_old_ver INTEGER;
    v_budget_usd NUMERIC;
    v_next_ver INTEGER;
    v_dev_id TEXT;
    v_locked_amt NUMERIC;
    v_lock_status TEXT;
    v_t1_release TIMESTAMPTZ;
    v_dispute_deadline TIMESTAMPTZ;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- 1. Lock Task Row
    SELECT status, "payoutStatus", version, "budgetUsd", "t1ReleaseAt", "disputeDeadlineAt"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd, v_t1_release, v_dispute_deadline
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_TASK_NOT_FOUND', 'message', 'Task not found');
    END IF;

    IF v_old_ver != p_expected_version THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_VERSION_CONFLICT', 'message', 'Version conflict');
    END IF;

    IF v_old_payout != 'settled' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_NOT_SETTLED', 'message', 'Task has not been settled, use regular refund instead');
    END IF;

    -- 1b. Validate dispute window has not expired and is defined (Fail-Closed)
    IF (v_dispute_deadline IS NULL AND v_t1_release IS NULL) OR v_now > COALESCE(v_dispute_deadline, v_t1_release) THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACP_CLAWBACK_WINDOW_EXPIRED',
            'message', 'Clawback dispute window is undefined or has expired at ' || COALESCE(v_dispute_deadline::text, v_t1_release::text, 'undefined')
        );
    END IF;

    -- 2. Check if T+0 guarantee deposit was used and is currently locked
    SELECT developer_id, locked_amount, status
      INTO v_dev_id, v_locked_amt, v_lock_status
      FROM task_t0_deposit_locks
     WHERE task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND OR v_lock_status != 'locked' THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACP_NO_ACTIVE_DEPOSIT_LOCK',
            'message', 'No active T+0 deposit lock found for task'
        );
    END IF;

    -- Deduct from locked deposit
    UPDATE developer_guarantee_deposits
       SET locked_deposit = locked_deposit - v_locked_amt,
           total_deposit = total_deposit - v_locked_amt,
           updated_at = v_now
     WHERE developer_id = v_dev_id;

    UPDATE task_t0_deposit_locks
       SET status = 'clawed_back',
           updated_at = v_now
     WHERE task_id = p_task_id;

    INSERT INTO deposit_ledger (developer_id, task_id, kind, amount, created_at)
    VALUES (v_dev_id, p_task_id, 'clawback_deduction', v_locked_amt, v_now);

    -- 3. Atomic CAS on agent_tasks to clawed_back
    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'disputed',
           "payoutStatus" = 'clawed_back',
           version = v_next_ver,
           "updatedAt" = v_now
     WHERE id = p_task_id;

    -- 4. Insert clawback into payout_ledger & agent_task_ledger
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES (p_task_id, 'clawback', v_budget_usd);

    INSERT INTO agent_task_ledger ("taskId", "eventType", "amountUsd", version)
    VALUES (p_task_id, 'refund', v_budget_usd, v_next_ver);

    RETURN jsonb_build_object('success', true, 'code', 'CLAWED_BACK', 'version', v_next_ver, 'amount', v_budget_usd);
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_CLAWBACK_FAILED', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- =========================================================================
-- Phase 5: Re-assert acp_refund_task with Stale Ledger Guard (PI P2-1)
-- =========================================================================
CREATE OR REPLACE FUNCTION acp_refund_task(
    p_task_id TEXT,
    p_expected_version INTEGER,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
    v_old_status TEXT;
    v_old_payout TEXT;
    v_old_ver INTEGER;
    v_budget_usd NUMERIC;
    v_actual_amount NUMERIC;
    v_next_ver INTEGER;
BEGIN
    SELECT status, "payoutStatus", version, "budgetUsd"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_TASK_NOT_FOUND', 'message', 'Task not found');
    END IF;

    IF v_old_status = 'refunded' AND v_old_payout = 'refunded' THEN
        RETURN jsonb_build_object('success', true, 'code', 'ALREADY_REFUNDED', 'idempotent', true);
    END IF;

    IF v_old_ver != p_expected_version THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_VERSION_CONFLICT', 'message', 'Version conflict');
    END IF;

    IF v_old_payout = 'settled' OR v_old_status = 'verified' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_REFUND_BLOCKED_BY_SETTLEMENT', 'message', 'Task has been settled to developer, refund blocked');
    END IF;
    IF v_old_status NOT IN ('disputed', 'failed', 'escrowed') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_REFUND_STATE', 'message', 'Cannot refund in status: ' || COALESCE(v_old_status, 'NULL'));
    END IF;

    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_REFUND_BLOCKED_BY_SETTLEMENT', 'message', 'Settle ledger exists, refund blocked');
    END IF;

    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_STALE_LEDGER_CONFLICT', 'message', 'Refund ledger already exists for non-refunded task');
    END IF;

    v_actual_amount := COALESCE(v_budget_usd, 0.00);

    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'refunded',
           "payoutStatus" = 'refunded',
           version = v_next_ver,
           "updatedAt" = NOW()
     WHERE id = p_task_id;

    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES (p_task_id, 'refund', v_actual_amount);

    INSERT INTO agent_task_ledger ("taskId", "eventType", "amountUsd", version)
    VALUES (p_task_id, 'refund', v_actual_amount, v_next_ver);

    RETURN jsonb_build_object('success', true, 'code', 'REFUNDED', 'version', v_next_ver, 'amount', v_actual_amount);
EXCEPTION
    WHEN unique_violation THEN
        IF v_old_status = 'refunded' AND v_old_payout = 'refunded' AND EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
            RETURN jsonb_build_object('success', true, 'code', 'ALREADY_REFUNDED', 'idempotent', true);
        ELSIF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
            RETURN jsonb_build_object('success', false, 'code', 'ACP_REFUND_BLOCKED_BY_SETTLEMENT', 'message', 'Task funds have been settled, refund rejected');
        ELSE
            RETURN jsonb_build_object('success', false, 'code', 'ACP_UNIQUE_VIOLATION', 'message', 'Ledger unique constraint violation');
        END IF;
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_DB_ERROR', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- =========================================================================
-- Phase 6: Definitive Universal ACL Revocation and Default Privileges
-- =========================================================================
DO $$ 
DECLARE 
    r record; 
BEGIN 
    FOR r IN 
        SELECT p.oid::regprocedure AS sig 
        FROM pg_proc p 
        JOIN pg_namespace n ON n.oid = p.pronamespace 
        WHERE n.nspname = 'public' AND p.proname LIKE 'acp\_%' 
    LOOP 
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig); 
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig); 
    END LOOP; 
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
