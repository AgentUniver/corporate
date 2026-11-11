-- Migration: 20261021200000_t1_t0_settlement_architecture.sql
-- Description: T+1 Settlement Hold, T+0 Deposit-Guaranteed Payout, Clawback State Transition, and Platform Reserve Ledger.

-- =========================================================================
-- Phase 1: Column Additions & Default Configurations on agent_tasks
-- =========================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'settlementType') THEN
        ALTER TABLE agent_tasks ADD COLUMN "settlementType" TEXT DEFAULT 't1_default';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 't1ReleaseAt') THEN
        ALTER TABLE agent_tasks ADD COLUMN "t1ReleaseAt" TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'acceptedByCustomerAt') THEN
        ALTER TABLE agent_tasks ADD COLUMN "acceptedByCustomerAt" TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'disputeDeadlineAt') THEN
        ALTER TABLE agent_tasks ADD COLUMN "disputeDeadlineAt" TIMESTAMPTZ;
    END IF;

    -- Backfill existing legacy rows: Default T+1 release to createdAt + 24 hours (prevents legacy tasks from hanging)
    UPDATE agent_tasks
    SET "settlementType" = 't1_default',
        "t1ReleaseAt" = COALESCE("createdAt", NOW()) + INTERVAL '24 hours'
    WHERE "t1ReleaseAt" IS NULL;
END $$;

-- =========================================================================
-- Phase 2: Guarantee Deposit System (developer_guarantee_deposits)
-- =========================================================================
CREATE TABLE IF NOT EXISTS developer_guarantee_deposits (
    developer_id TEXT PRIMARY KEY,
    total_deposit NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (total_deposit >= 0.00),
    locked_deposit NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (locked_deposit >= 0.00),
    available_deposit NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (available_deposit >= 0.00),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_deposit_balance CHECK (ROUND(available_deposit + locked_deposit, 2) = ROUND(total_deposit, 2))
);

CREATE TABLE IF NOT EXISTS deposit_ledger (
    id BIGSERIAL PRIMARY KEY,
    developer_id TEXT NOT NULL REFERENCES developer_guarantee_deposits(developer_id) ON DELETE CASCADE,
    task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('deposit_inflow', 't0_lock', 't0_unlock', 'clawback_deduction', 'deposit_withdrawal')),
    amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0.00),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_t0_deposit_locks (
    task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
    developer_id TEXT NOT NULL REFERENCES developer_guarantee_deposits(developer_id),
    locked_amount NUMERIC(12, 2) NOT NULL CHECK (locked_amount > 0.00),
    status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'released', 'clawed_back')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_task_t0_locks_dev ON task_t0_deposit_locks(developer_id, status);

ALTER TABLE developer_guarantee_deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_t0_deposit_locks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE developer_guarantee_deposits FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE deposit_ledger FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE task_t0_deposit_locks FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE developer_guarantee_deposits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE deposit_ledger TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE task_t0_deposit_locks TO service_role;

DROP POLICY IF EXISTS "Service role full access on developer_guarantee_deposits" ON developer_guarantee_deposits;
CREATE POLICY "Service role full access on developer_guarantee_deposits" ON developer_guarantee_deposits FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on deposit_ledger" ON deposit_ledger;
CREATE POLICY "Service role full access on deposit_ledger" ON deposit_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on task_t0_deposit_locks" ON task_t0_deposit_locks;
CREATE POLICY "Service role full access on task_t0_deposit_locks" ON task_t0_deposit_locks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =========================================================================
-- Phase 3: Platform Reserve Account & Advance Payout Ledger
-- =========================================================================
CREATE TABLE IF NOT EXISTS platform_reserve_account (
    id TEXT PRIMARY KEY DEFAULT 'PLATFORM_MAIN_RESERVE',
    balance_usd NUMERIC(12, 2) NOT NULL DEFAULT 5000.00 CHECK (balance_usd >= 0.00),
    max_advance_per_task NUMERIC(10, 2) NOT NULL DEFAULT 100.00,
    max_advance_per_developer NUMERIC(10, 2) NOT NULL DEFAULT 300.00,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed initial reserve account if missing
INSERT INTO platform_reserve_account (id, balance_usd, max_advance_per_task, max_advance_per_developer)
VALUES ('PLATFORM_MAIN_RESERVE', 5000.00, 100.00, 300.00)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_reserve_ledger (
    id BIGSERIAL PRIMARY KEY,
    task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
    developer_id TEXT NOT NULL,
    customer_email TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('advance_payout', 'recovery_inflow', 'bad_debt_writeoff')),
    amount_usd NUMERIC(10, 2) NOT NULL CHECK (amount_usd > 0.00),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_reserve_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_reserve_ledger ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE platform_reserve_account FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE platform_reserve_ledger FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE platform_reserve_account TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE platform_reserve_ledger TO service_role;

DROP POLICY IF EXISTS "Service role full access on platform_reserve_account" ON platform_reserve_account;
CREATE POLICY "Service role full access on platform_reserve_account" ON platform_reserve_account FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access on platform_reserve_ledger" ON platform_reserve_ledger;
CREATE POLICY "Service role full access on platform_reserve_ledger" ON platform_reserve_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =========================================================================
-- Phase 4: Payout Ledger Clawback Expansion & Index Hardening
-- =========================================================================
-- Expand payout_ledger check constraint to include 'clawback'
ALTER TABLE payout_ledger DROP CONSTRAINT IF EXISTS payout_ledger_kind_check;
ALTER TABLE payout_ledger ADD CONSTRAINT payout_ledger_kind_check CHECK (kind IN ('escrow', 'settle', 'refund', 'clawback'));

-- Single clawback per task index
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_single_clawback ON payout_ledger(task_id) WHERE kind = 'clawback';

-- Expand agent_tasks payoutStatus check constraints to permit 'clawed_back'
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_payoutStatus_check";
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_payoutStatus_check;
ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_payoutStatus_check" CHECK (
    "payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled', 'refunded', 'failed', 'clawed_back')
) NOT VALID;
ALTER TABLE agent_tasks VALIDATE CONSTRAINT "agent_tasks_payoutStatus_check";

ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_status_payout_consistency_check";
ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_status_payout_consistency_check" CHECK (
    (status = 'pending' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed')))
    OR (status = 'escrowed' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed')))
    OR (status = 'processing' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed')))
    OR (status = 'delivered' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled')))
    OR (status = 'disputed' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled', 'refunded', 'failed', 'clawed_back')))
    OR (status = 'verified' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled')))
    OR (status = 'completed' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled')))
    OR (status = 'refunded' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'refunded')))
    OR (status = 'failed' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'refunded', 'failed')))
    OR (status = 'cancelled' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'refunded', 'failed', 'settled')))
) NOT VALID;
ALTER TABLE agent_tasks VALIDATE CONSTRAINT "agent_tasks_status_payout_consistency_check";

-- =========================================================================
-- Phase 5: Trigger Exception for Clawback State Transition
-- =========================================================================
CREATE OR REPLACE FUNCTION trg_agent_tasks_monotonic_version()
RETURNS TRIGGER AS $$
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
            -- Allow dispute from verified for clawback review
            NULL;
        ELSE
            RAISE EXCEPTION 'illegal transition % -> %', OLD.status, NEW.status;
        END IF;
    END IF;

    -- 3. Settlement immutability with controlled exception for clawback
    IF OLD."payoutStatus" = 'settled' AND NEW."payoutStatus" IS DISTINCT FROM 'settled' THEN
        -- Allow transition to 'clawed_back' only
        IF NEW."payoutStatus" != 'clawed_back' THEN
            RAISE EXCEPTION 'settled immutable: cannot transition payoutStatus from settled to %', NEW."payoutStatus";
        END IF;
    END IF;

    IF OLD."payoutStatus" = 'settled' AND NEW."payoutStatus" = 'settled' THEN
        IF NEW.status IN ('refunded', 'pending', 'escrowed', 'processing') THEN
            RAISE EXCEPTION 'settled status frozen: cannot regress verified/settled task status to %', NEW.status;
        END IF;
    END IF;

    -- 4. Initialize T+1 hold on delivery if not already set
    IF NEW.status = 'delivered' AND (OLD.status IS DISTINCT FROM 'delivered') THEN
        IF NEW."t1ReleaseAt" IS NULL THEN
            NEW."t1ReleaseAt" := clock_timestamp() + INTERVAL '24 hours';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =========================================================================
-- Phase 6: Core Atomic Settlement & T+0 Stored Procedures
-- =========================================================================

-- Drop obsolete 3-arg overload before defining 4-arg function
DROP FUNCTION IF EXISTS acp_settle_task(TEXT, INTEGER, NUMERIC);

-- 1. Hardened acp_settle_task with T+1 Hold / Customer Acceptance Check
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

    -- 6b. Check existing settle in payout_ledger on unverified task
    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_STALE_LEDGER_CONFLICT', 'message', 'Settle ledger already exists for unverified task');
    END IF;

    -- 7. T+1 Hold / Customer Acceptance Boundary Check (Authoritative DB Time)
    IF p_customer_accepted THEN
        v_accepted_at := v_now;
    ELSE
        -- If customer has not explicitly accepted, require T+1 hold to have elapsed
        -- Fail closed: if v_t1_release is NULL, settlement must not proceed automatically
        IF v_t1_release IS NULL OR (v_now < v_t1_release AND v_accepted_at IS NULL) THEN
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
           "acceptedByCustomerAt" = COALESCE("acceptedByCustomerAt", v_accepted_at),
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

-- 2. Atomic T+0 Payout with Guarantee Deposit (acp_t0_payout_with_deposit)
CREATE OR REPLACE FUNCTION acp_t0_payout_with_deposit(
    p_task_id TEXT,
    p_developer_id TEXT,
    p_expected_version INTEGER
)
RETURNS JSONB AS $$
DECLARE
    v_old_status TEXT;
    v_old_payout TEXT;
    v_old_ver INTEGER;
    v_budget_usd NUMERIC;
    v_next_ver INTEGER;
    v_avail_deposit NUMERIC;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- 1. Lock Task Row
    SELECT status, "payoutStatus", version, "budgetUsd"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_TASK_NOT_FOUND', 'message', 'Task not found');
    END IF;

    IF v_old_ver != p_expected_version THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_VERSION_CONFLICT', 'message', 'Version conflict');
    END IF;

    -- 2. Verify single T+0 lock per task (Prioritized before state checks to prevent replay)
    IF EXISTS (SELECT 1 FROM task_t0_deposit_locks WHERE task_id = p_task_id) THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_T0_ALREADY_LOCKED', 'message', 'T+0 deposit already locked for this task');
    END IF;

    IF v_old_status NOT IN ('delivered', 'completed') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_SETTLEMENT_STATE', 'message', 'Cannot perform T+0 settlement in status: ' || COALESCE(v_old_status, 'NULL'));
    END IF;

    IF v_old_payout = 'settled' THEN
        RETURN jsonb_build_object('success', true, 'code', 'ALREADY_SETTLED', 'idempotent', true);
    END IF;
    IF v_old_payout = 'refunded' OR v_old_status = 'refunded' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds already refunded');
    END IF;

    -- 3. Lock Developer Deposit Row
    SELECT available_deposit
      INTO v_avail_deposit
      FROM developer_guarantee_deposits
     WHERE developer_id = p_developer_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_NO_DEPOSIT_ACCOUNT', 'message', 'Developer has no guarantee deposit account');
    END IF;

    -- 4. Check deposit balance sufficiency
    IF v_avail_deposit < v_budget_usd THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACP_INSUFFICIENT_DEPOSIT',
            'message', 'Available deposit balance ($' || v_avail_deposit || ') is less than task amount ($' || v_budget_usd || ')'
        );
    END IF;

    -- 5. Atomically lock guarantee deposit
    UPDATE developer_guarantee_deposits
       SET available_deposit = available_deposit - v_budget_usd,
           locked_deposit = locked_deposit + v_budget_usd,
           updated_at = v_now
     WHERE developer_id = p_developer_id;

    -- 6. Insert lock record
    INSERT INTO task_t0_deposit_locks (task_id, developer_id, locked_amount, status, created_at, updated_at)
    VALUES (p_task_id, p_developer_id, v_budget_usd, 'locked', v_now, v_now);

    -- 7. Record deposit ledger entry
    INSERT INTO deposit_ledger (developer_id, task_id, kind, amount, created_at)
    VALUES (p_developer_id, p_task_id, 't0_lock', v_budget_usd, v_now);

    -- 8. Mutate task row to settled (T+0 instant release)
    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'verified',
           "payoutStatus" = 'settled',
           "settlementType" = 't0_guaranteed',
           version = v_next_ver,
           "updatedAt" = v_now
     WHERE id = p_task_id;

    -- 9. Insert into payout_ledger & agent_task_ledger
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES (p_task_id, 'settle', v_budget_usd);

    INSERT INTO agent_task_ledger ("taskId", "eventType", "amountUsd", version)
    VALUES (p_task_id, 'payout', v_budget_usd, v_next_ver);

    RETURN jsonb_build_object(
        'success', true,
        'code', 'T0_SETTLED_WITH_DEPOSIT',
        'version', v_next_ver,
        'amount', v_budget_usd,
        'locked_deposit', v_budget_usd
    );
EXCEPTION
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_T0_FAILED', 'message', SQLERRM);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 3. Release Expired Locked Guarantee Deposits (acp_release_expired_locked_deposits)
CREATE OR REPLACE FUNCTION acp_release_expired_locked_deposits(
    p_task_id TEXT
)
RETURNS JSONB AS $$
DECLARE
    v_dev_id TEXT;
    v_locked_amt NUMERIC;
    v_lock_status TEXT;
    v_t1_release TIMESTAMPTZ;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- 1. Lock lock record
    SELECT developer_id, locked_amount, status
      INTO v_dev_id, v_locked_amt, v_lock_status
      FROM task_t0_deposit_locks
     WHERE task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_LOCK_NOT_FOUND', 'message', 'No T+0 lock found for task');
    END IF;

    IF v_lock_status != 'locked' THEN
        RETURN jsonb_build_object('success', true, 'code', 'ALREADY_PROCESSED', 'status', v_lock_status);
    END IF;

    -- 2. Verify T+1 dispute window has elapsed
    SELECT "t1ReleaseAt"
      INTO v_t1_release
      FROM agent_tasks
     WHERE id = p_task_id;

    IF v_t1_release IS NULL OR v_now < v_t1_release THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_DISPUTE_WINDOW_ACTIVE', 'message', 'Dispute window is still active or undefined');
    END IF;

    -- 3. Atomically release deposit
    UPDATE developer_guarantee_deposits
       SET locked_deposit = locked_deposit - v_locked_amt,
           available_deposit = available_deposit + v_locked_amt,
           updated_at = v_now
     WHERE developer_id = v_dev_id;

    UPDATE task_t0_deposit_locks
       SET status = 'released',
           updated_at = v_now
     WHERE task_id = p_task_id;

    INSERT INTO deposit_ledger (developer_id, task_id, kind, amount, created_at)
    VALUES (v_dev_id, p_task_id, 't0_unlock', v_locked_amt, v_now);

    RETURN jsonb_build_object('success', true, 'code', 'DEPOSIT_UNLOCKED', 'released_amount', v_locked_amt);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 4. Atomic Clawback RPC (acp_clawback_task)
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
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- 1. Lock Task Row
    SELECT status, "payoutStatus", version, "budgetUsd"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd
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

    -- 2. Check if T+0 guarantee deposit was used
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
-- Phase 7: Universal ACL Hardening for all acp_% functions
-- =========================================================================
DROP FUNCTION IF EXISTS acp_settle_task(TEXT, INTEGER, NUMERIC);

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

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
