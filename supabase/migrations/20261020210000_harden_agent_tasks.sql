-- Migration: 20261020210000_harden_agent_tasks.sql
-- Description: Harden agent_tasks trigger for terminal state immutability (P1-4), version guard (P0-2), dirty row remediation, and anon RLS (P1-3)

-- 0. Guarantee table and version column existence under arbitrary execution order (P1-8 / P0-2)
CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "taskToken" TEXT,
    "userEmail" TEXT,
    "agentId" TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    "payoutStatus" TEXT DEFAULT 'pending',
    "budgetUsd" NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
    "platformFeeUsd" NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    quantity INTEGER DEFAULT 1,
    "unitPriceUsd" NUMERIC(10, 2),
    "priceCeilingUsd" NUMERIC(10, 2),
    "estimatedComputeUsd" NUMERIC(10, 2),
    "actualCostUsd" NUMERIC(10, 2),
    version INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
    IF to_regclass('public.agent_tasks') IS NOT NULL THEN
        -- Ensure version column exists on existing legacy tables
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'version') THEN
            ALTER TABLE agent_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        END IF;

        -- Ensure financial and quantity columns exist under bare dictionary-order execution (T1 / P0-2)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'quantity') THEN
            ALTER TABLE agent_tasks ADD COLUMN quantity INTEGER DEFAULT 1;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'unitPriceUsd') THEN
            ALTER TABLE agent_tasks ADD COLUMN "unitPriceUsd" NUMERIC(10, 2);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'priceCeilingUsd') THEN
            ALTER TABLE agent_tasks ADD COLUMN "priceCeilingUsd" NUMERIC(10, 2);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'estimatedComputeUsd') THEN
            ALTER TABLE agent_tasks ADD COLUMN "estimatedComputeUsd" NUMERIC(10, 2);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'actualCostUsd') THEN
            ALTER TABLE agent_tasks ADD COLUMN "actualCostUsd" NUMERIC(10, 2);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'payoutAddress') THEN
            ALTER TABLE agent_tasks ADD COLUMN "payoutAddress" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'payoutTxHash') THEN
            ALTER TABLE agent_tasks ADD COLUMN "payoutTxHash" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'deliverableFingerprint') THEN
            ALTER TABLE agent_tasks ADD COLUMN "deliverableFingerprint" JSONB;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'arbitrationVerdict') THEN
            ALTER TABLE agent_tasks ADD COLUMN "arbitrationVerdict" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'resultPayload') THEN
            ALTER TABLE agent_tasks ADD COLUMN "resultPayload" JSONB;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'agentName') THEN
            ALTER TABLE agent_tasks ADD COLUMN "agentName" TEXT DEFAULT 'Agent';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'subdomain') THEN
            ALTER TABLE agent_tasks ADD COLUMN "subdomain" TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'taskTitle') THEN
            ALTER TABLE agent_tasks ADD COLUMN "taskTitle" TEXT DEFAULT 'Task';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'taskDescription') THEN
            ALTER TABLE agent_tasks ADD COLUMN "taskDescription" TEXT;
        END IF;

        -- Pre-repair legacy dirty status/payoutStatus pairs to strict whitelist values (Claude spec: schema.sql:89)
        -- 1. cancelled with dirty payoutStatus -> refunded (with monotonic version increment)
        UPDATE agent_tasks 
        SET "payoutStatus" = 'refunded',
            version = COALESCE(version, 0) + 1
        WHERE status = 'cancelled' 
          AND ("payoutStatus" IS NULL OR "payoutStatus" NOT IN ('refunded', 'failed', 'settled'));

        -- 2. verified with NULL payoutStatus -> settled (with version increment)
        UPDATE agent_tasks
        SET "payoutStatus" = 'settled',
            version = COALESCE(version, 0) + 1
        WHERE status = 'verified' AND "payoutStatus" IS NULL;

        -- 3. delivered with settled payoutStatus -> disputed to retain audit trail without erasing financial fact
        UPDATE agent_tasks
        SET status = 'disputed',
            version = COALESCE(version, 0) + 1
        WHERE status = 'delivered' AND "payoutStatus" = 'settled';
    END IF;
END $$;

-- 1. Upgrade monotonic version function to enforce terminal state immutability (P1-4 / P0-3 / Claude Spec)
CREATE OR REPLACE FUNCTION trg_agent_tasks_monotonic_version()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. Monotonic version fencing (P1-2)
    IF NEW.version IS NULL OR (OLD.version IS NOT NULL AND NEW.version <= OLD.version) THEN
        RAISE EXCEPTION 'Monotonic version violation: NEW.version (%) must be strictly greater than OLD.version (%)', NEW.version, OLD.version;
    END IF;

    -- 2. State transition whitelist (Claude authoritative specification)
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
        ELSE
            RAISE EXCEPTION 'illegal transition % -> %', OLD.status, NEW.status;
        END IF;
    END IF;

    -- 3. Settlement immutability: once settled, payoutStatus is frozen permanently (Claude spec / DSH)
    IF OLD."payoutStatus" = 'settled' AND NEW."payoutStatus" IS DISTINCT FROM 'settled' THEN
        RAISE EXCEPTION 'settled immutable';
    END IF;
    IF OLD."payoutStatus" = 'settled' AND NEW.status IN ('refunded', 'pending', 'escrowed', 'processing') THEN
        RAISE EXCEPTION 'settled status frozen';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_version_fence ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_version_fence
    BEFORE UPDATE ON agent_tasks
    FOR EACH ROW
    EXECUTE FUNCTION trg_agent_tasks_monotonic_version();

-- 2. Update insert policy: anon users strictly cannot spoof userEmail
DROP POLICY IF EXISTS "Clients can insert new orders" ON agent_tasks;
CREATE POLICY "Clients can insert new orders"
    ON agent_tasks
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (
        status IN ('pending', 'escrowed')
        AND ("payoutStatus" IS NULL OR "payoutStatus" = 'pending' OR "payoutStatus" = 'escrowed')
        AND "budgetUsd" >= 0.05
        AND "budgetUsd" <= 1000.00
        AND "platformFeeUsd" >= 0.00
        AND "platformFeeUsd" <= "budgetUsd"
        AND (quantity IS NULL OR (quantity >= 1 AND quantity <= 1000))
        AND ("unitPriceUsd" IS NULL OR ("unitPriceUsd" >= 0.01 AND "unitPriceUsd" <= 1000.00))
        AND (quantity IS NULL OR "unitPriceUsd" IS NULL OR (quantity * "unitPriceUsd" <= 1000.00))
        AND ("priceCeilingUsd" IS NULL OR ("priceCeilingUsd" >= 0.05 AND "priceCeilingUsd" <= 1000.00))
        AND ("estimatedComputeUsd" IS NULL OR ("estimatedComputeUsd" >= 0 AND "estimatedComputeUsd" <= 1000.00))
        AND (
            "taskToken" IS NULL
            OR ("taskToken" ~ '^tok_[a-zA-Z0-9]{16,64}$' AND length("taskToken") >= 20)
        )
        AND "actualCostUsd" IS NULL
        AND "payoutAddress" IS NULL
        AND "payoutTxHash" IS NULL
        AND "deliverableFingerprint" IS NULL
        AND "arbitrationVerdict" IS NULL
        AND "resultPayload" IS NULL
        AND (
            -- Authenticated user: email MUST match JWT email
            (auth.role() = 'authenticated' AND auth.jwt() ->> 'email' IS NOT NULL AND "userEmail" = (auth.jwt() ->> 'email'))
            OR
            -- Anonymous user: CANNOT forge arbitrary emails; userEmail MUST be NULL (P1-3)
            (auth.role() = 'anon' AND "userEmail" IS NULL)
        )
    );

-- =========================================================================
-- Phase 3: Double-Spend Prevention Ledger Tables (Claude Spec)
-- =========================================================================
CREATE TABLE IF NOT EXISTS payout_ledger (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('escrow', 'settle', 'refund')),
    amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Claude spec: 账本兜底条件唯一索引 (同一任务 settle 与 refund 互斥，物理并发防双花)
DROP INDEX IF EXISTS uq_ledger_settle;
DROP INDEX IF EXISTS uq_ledger_refund;
DROP INDEX IF EXISTS uq_payout_ledger_exclusive_settle_refund;

-- Archive conflicting duplicates before deduplication (PI & DSH P1)
CREATE TABLE IF NOT EXISTS payout_ledger_conflicts_archive (
    archive_id BIGSERIAL PRIMARY KEY,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    conflict_reason TEXT NOT NULL,
    id TEXT,
    task_id TEXT,
    kind TEXT,
    amount NUMERIC(10, 2),
    created_at TIMESTAMPTZ
);

ALTER TABLE payout_ledger_conflicts_archive ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE payout_ledger_conflicts_archive FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE payout_ledger_conflicts_archive TO service_role;
DROP POLICY IF EXISTS "Service role full access on payout_ledger_conflicts_archive" ON payout_ledger_conflicts_archive;
CREATE POLICY "Service role full access on payout_ledger_conflicts_archive" ON payout_ledger_conflicts_archive FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO payout_ledger_conflicts_archive (conflict_reason, id, task_id, kind, amount, created_at)
SELECT 'pre_index_conflicting_row', p.id, p.task_id, p.kind, p.amount, p.created_at
FROM payout_ledger p
JOIN (
    SELECT task_id
    FROM payout_ledger
    WHERE kind IN ('settle', 'refund')
    GROUP BY task_id
    HAVING COUNT(*) > 1
) dup ON p.task_id = dup.task_id
WHERE p.kind IN ('settle', 'refund');

-- Deterministic deduplication aligned with agent_tasks payoutStatus / lifecycle
WITH ranked_rows AS (
    SELECT p.id,
           ROW_NUMBER() OVER (
               PARTITION BY p.task_id
               ORDER BY
                   CASE
                       WHEN t."payoutStatus" = 'settled' AND p.kind = 'settle' THEN 1
                       WHEN (t.status = 'refunded' OR t."payoutStatus" = 'refunded') AND p.kind = 'refund' THEN 1
                       WHEN p.kind = 'refund' THEN 2
                       ELSE 3
                   END,
                   p.created_at ASC NULLS LAST,
                   p.id ASC
           ) as rn
    FROM payout_ledger p
    LEFT JOIN agent_tasks t ON t.id = p.task_id
    WHERE p.kind IN ('settle', 'refund')
)
DELETE FROM payout_ledger
WHERE id IN (
    SELECT id FROM ranked_rows WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_exclusive
ON payout_ledger(task_id)
WHERE kind IN ('settle', 'refund');
CREATE INDEX IF NOT EXISTS idx_payout_ledger_task_id ON payout_ledger(task_id);

ALTER TABLE payout_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access on payout_ledger" ON payout_ledger;
CREATE POLICY "Service role full access on payout_ledger" ON payout_ledger FOR ALL TO service_role USING (true) WITH CHECK (true);

-- =========================================================================
-- Phase 4: Atomic Settlement RPC (Claude Spec: CAS + Ledger in single TX)
-- =========================================================================
CREATE OR REPLACE FUNCTION acp_settle_task(
    p_task_id TEXT,
    p_expected_version INTEGER,
    p_amount NUMERIC DEFAULT NULL
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
    -- 1. Lock row
    SELECT status, "payoutStatus", version, "budgetUsd"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_TASK_NOT_FOUND', 'message', 'Task not found');
    END IF;

    -- 2. Idempotent return if already verified or settled
    IF v_old_status = 'verified' AND v_old_payout = 'settled' THEN
        RETURN jsonb_build_object('success', true, 'code', 'ALREADY_SETTLED', 'idempotent', true);
    END IF;

    -- 3. Version CAS check
    IF v_old_ver != p_expected_version THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_VERSION_CONFLICT', 'message', 'Version conflict');
    END IF;

    -- 4. Status eligibility check
    IF v_old_status NOT IN ('delivered', 'completed') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_SETTLEMENT_STATE', 'message', 'Cannot settle in current status');
    END IF;

    -- 5. PayoutStatus CAS check
    IF v_old_payout = 'settled' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_ALREADY_SETTLED', 'message', 'Payout already settled');
    END IF;
    IF v_old_payout = 'refunded' OR v_old_status = 'refunded' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds have been refunded, settlement rejected');
    END IF;

    -- 6. Check existing refund in payout_ledger (Claude requirement)
    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds have been refunded, settlement rejected');
    END IF;

    -- 7. Enforce authoritative amount from locked row (DSH P0-B / P1-6 / P2)
    IF v_budget_usd IS NULL OR v_budget_usd <= 0 THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_BUDGET', 'message', 'Task lacks authoritative budgetUsd');
    END IF;
    v_actual_amount := v_budget_usd;

    -- 8. Atomic CAS Update
    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'verified',
           "payoutStatus" = 'settled',
           version = v_next_ver,
           "updatedAt" = NOW()
     WHERE id = p_task_id;

    -- 9. Insert into payout_ledger (guaranteed exclusive by uq_ledger_exclusive)
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES (p_task_id, 'settle', v_actual_amount);

    -- 10. Insert into agent_task_ledger
    INSERT INTO agent_task_ledger ("taskId", "eventType", "amountUsd", version)
    VALUES (p_task_id, 'payout', v_actual_amount, v_next_ver);

    RETURN jsonb_build_object('success', true, 'code', 'SETTLED', 'version', v_next_ver, 'amount', v_actual_amount);
EXCEPTION
    WHEN unique_violation THEN
        -- DSH P1-2 & PI P2: 精准区分幂等已结算与退款账本冲突
        IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
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

-- ACL Hardening (P0-B): Strictly revoke from PUBLIC, anon, and authenticated; grant solely to service_role
REVOKE EXECUTE ON FUNCTION acp_settle_task(TEXT, INTEGER, NUMERIC) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION acp_settle_task(TEXT, INTEGER, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION acp_settle_task(TEXT, INTEGER, NUMERIC) FROM authenticated;
GRANT EXECUTE ON FUNCTION acp_settle_task(TEXT, INTEGER, NUMERIC) TO service_role;

-- =========================================================================
-- Phase 5: Atomic Refund RPC (Claude Spec: Single TX CAS + Ledger)
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
    -- 1. Lock row
    SELECT status, "payoutStatus", version, "budgetUsd"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_TASK_NOT_FOUND', 'message', 'Task not found');
    END IF;

    -- 2. Idempotent return if already refunded
    IF v_old_status = 'refunded' AND v_old_payout = 'refunded' THEN
        RETURN jsonb_build_object('success', true, 'code', 'ALREADY_REFUNDED', 'idempotent', true);
    END IF;

    -- 3. Version CAS check
    IF v_old_ver != p_expected_version THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_VERSION_CONFLICT', 'message', 'Version conflict');
    END IF;

    -- 4. Status eligibility check: only disputed, failed, or escrowed can be refunded
    IF v_old_payout = 'settled' OR v_old_status = 'verified' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_REFUND_BLOCKED_BY_SETTLEMENT', 'message', 'Task has been settled to developer, refund blocked');
    END IF;
    IF v_old_status NOT IN ('disputed', 'failed', 'escrowed') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_REFUND_STATE', 'message', 'Cannot refund in status: ' || COALESCE(v_old_status, 'NULL'));
    END IF;

    -- 5. Check existing settle in payout_ledger
    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_REFUND_BLOCKED_BY_SETTLEMENT', 'message', 'Settle ledger exists, refund blocked');
    END IF;

    -- 6. Enforce budget amount
    v_actual_amount := COALESCE(v_budget_usd, 0.00);

    -- 7. Atomic CAS Update
    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'refunded',
           "payoutStatus" = 'refunded',
           version = v_next_ver,
           "updatedAt" = NOW()
     WHERE id = p_task_id;

    -- 8. Insert into payout_ledger (guaranteed exclusive against settle by uq_ledger_exclusive)
    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES (p_task_id, 'refund', v_actual_amount);

    -- 9. Insert into agent_task_ledger
    INSERT INTO agent_task_ledger ("taskId", "eventType", "amountUsd", version)
    VALUES (p_task_id, 'refund', v_actual_amount, v_next_ver);

    RETURN jsonb_build_object('success', true, 'code', 'REFUNDED', 'version', v_next_ver, 'amount', v_actual_amount);
EXCEPTION
    WHEN unique_violation THEN
        IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
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

REVOKE EXECUTE ON FUNCTION acp_refund_task(TEXT, INTEGER, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION acp_refund_task(TEXT, INTEGER, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION acp_refund_task(TEXT, INTEGER, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION acp_refund_task(TEXT, INTEGER, TEXT) TO service_role;

CREATE TABLE IF NOT EXISTS agent_task_ledger (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "taskId" TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
    "eventType" TEXT NOT NULL CHECK ("eventType" IN ('escrow', 'payout', 'refund')),
    "amountUsd" NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    version INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_agent_task_ledger_event UNIQUE ("taskId", "eventType")
);

CREATE INDEX IF NOT EXISTS idx_agent_task_ledger_task_id ON agent_task_ledger ("taskId");

ALTER TABLE agent_task_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on agent_task_ledger" ON agent_task_ledger;
CREATE POLICY "Service role full access on agent_task_ledger"
    ON agent_task_ledger
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
