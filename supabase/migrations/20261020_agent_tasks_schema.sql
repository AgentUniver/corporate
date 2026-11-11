-- Migration: 20261020_agent_tasks_schema.sql
-- Description: Canonical schema definition for agent_tasks with resilient multi-phase migration, full state-machine matrix check, monotonic version CAS fencing, and zero-leakage RLS policies.

CREATE TABLE IF NOT EXISTS agent_tasks (
    id TEXT PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    subdomain TEXT NOT NULL,
    "taskTitle" TEXT NOT NULL,
    "taskDescription" TEXT NOT NULL,
    parameters JSONB DEFAULT '{}'::jsonb,
    "budgetUsd" NUMERIC(12, 4) NOT NULL DEFAULT 0.10,
    "platformFeeUsd" NUMERIC(12, 4) NOT NULL DEFAULT 0.00,
    status TEXT NOT NULL DEFAULT 'escrowed',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "deliveredAt" TIMESTAMPTZ,
    "latencyMs" INTEGER,
    "userEmail" TEXT,
    "resultPayload" JSONB,
    "orderType" TEXT CHECK ("orderType" IN ('result_based', 'task_based')),
    quantity INTEGER,
    "unitPriceUsd" NUMERIC(12, 4),
    "resultMetric" TEXT,
    "slaThreshold" TEXT,
    "disputeReason" TEXT,
    "taskToken" TEXT,
    "estimatedComputeUsd" NUMERIC(12, 4),
    "estimatedLoopSteps" INTEGER,
    "urgencyMultiplier" NUMERIC(6, 2) DEFAULT 1.0,
    "priceCeilingUsd" NUMERIC(12, 4),
    "reauthorizationRequired" BOOLEAN DEFAULT FALSE,
    "actualCostUsd" NUMERIC(12, 4),
    "costBreakdown" JSONB,
    "payoutRail" TEXT CHECK ("payoutRail" IN ('fiat_stripe', 'fiat_wise', 'fiat_payoneer', 'crypto_usdc')),
    "payoutAddress" TEXT,
    "payoutStatus" TEXT,
    "payoutTxHash" TEXT,
    "deliverableFingerprint" JSONB,
    "arbitrationVerdict" JSONB,
    agent_slug TEXT,
    version INTEGER NOT NULL DEFAULT 1
);

-- =========================================================================
-- Phase 1: Column Additions & Default Configurations
-- =========================================================================
DO $$
BEGIN
    -- 1. Ensure all columns exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'agent_slug') THEN
        ALTER TABLE agent_tasks ADD COLUMN agent_slug TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'deliveredAt') THEN
        ALTER TABLE agent_tasks ADD COLUMN "deliveredAt" TIMESTAMPTZ;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'latencyMs') THEN
        ALTER TABLE agent_tasks ADD COLUMN "latencyMs" INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'deliverableFingerprint') THEN
        ALTER TABLE agent_tasks ADD COLUMN "deliverableFingerprint" JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'arbitrationVerdict') THEN
        ALTER TABLE agent_tasks ADD COLUMN "arbitrationVerdict" JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'disputeReason') THEN
        ALTER TABLE agent_tasks ADD COLUMN "disputeReason" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'payoutStatus') THEN
        ALTER TABLE agent_tasks ADD COLUMN "payoutStatus" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_tasks' AND column_name = 'version') THEN
        ALTER TABLE agent_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    END IF;

    -- 2. Configure column defaults
    ALTER TABLE agent_tasks ALTER COLUMN status SET DEFAULT 'escrowed';
    ALTER TABLE agent_tasks ALTER COLUMN version SET DEFAULT 1;
    ALTER TABLE agent_tasks ALTER COLUMN "taskToken" SET DEFAULT ('tok_' || replace(gen_random_uuid()::text, '-', ''));
END $$;

-- =========================================================================
-- Phase 2: Constraint Rebuilding (NOT VALID, Non-Destructive, Claude Spec)
-- =========================================================================
DO $$
BEGIN
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

    -- 1. Status Check Constraint Rebuild (Gracefully supports historic cancelled status without data loss, P0-B)
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_status_check";
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_status_check;
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS check_agent_tasks_status;
    ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_status_check" CHECK (
        status IN (
            'pending',
            'escrowed',
            'processing',
            'delivered',
            'verified',
            'disputed',
            'refunded',
            'failed',
            'completed',
            'cancelled'
        )
    ) NOT VALID;

    -- 2. PayoutStatus Check Constraint Rebuild (Permits pending/escrowed/settled/refunded/failed or NULL)
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_payoutStatus_check";
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_payoutStatus_check;
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_payoutstatus_check;
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS check_agent_tasks_payout_status;
    ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_payoutStatus_check" CHECK (
        "payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled', 'refunded', 'failed', 'clawed_back')
    ) NOT VALID;

    -- 3. Exhaustive State Machine Ledger Consistency Check (Non-destructive to all 6 historical dirty row classes, P0-2 / P0-3)
    -- Protects financial semantic truth without arbitrary data mutation:
    -- Verified/completed/refunded/delivered/cancelled/failed with legacy NULL or historic status smoothly pass validation
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

    -- 4. Financial Caps & Quantity Bounding Check (P0-C)
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_financial_limits_check";
    ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_financial_limits_check" CHECK (
        "budgetUsd" >= 0.05 AND "budgetUsd" <= 1000.00
        AND (quantity IS NULL OR (quantity >= 1 AND quantity <= 1000))
        AND ("unitPriceUsd" IS NULL OR ("unitPriceUsd" >= 0.01 AND "unitPriceUsd" <= 1000.00))
        AND (quantity IS NULL OR "unitPriceUsd" IS NULL OR (quantity * "unitPriceUsd" <= 1000.00))
        AND ("platformFeeUsd" >= 0.00 AND "platformFeeUsd" <= "budgetUsd")
        AND ("priceCeilingUsd" IS NULL OR ("priceCeilingUsd" >= 0.05 AND "priceCeilingUsd" <= 1000.00))
        AND ("estimatedComputeUsd" IS NULL OR ("estimatedComputeUsd" >= 0 AND "estimatedComputeUsd" <= 1000.00))
    ) NOT VALID;
END $$;

-- =========================================================================
-- Phase 3: Constraint Validation (P0-B: No silent swallowing, completely convalidated)
-- =========================================================================
ALTER TABLE agent_tasks VALIDATE CONSTRAINT "agent_tasks_status_check";
ALTER TABLE agent_tasks VALIDATE CONSTRAINT "agent_tasks_payoutStatus_check";
ALTER TABLE agent_tasks VALIDATE CONSTRAINT "agent_tasks_status_payout_consistency_check";
ALTER TABLE agent_tasks VALIDATE CONSTRAINT "agent_tasks_financial_limits_check";

-- Indexes for high-frequency queries and joins
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks (status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id ON agent_tasks ("agentId");
CREATE INDEX IF NOT EXISTS idx_agent_tasks_task_token ON agent_tasks ("taskToken");
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated_at ON agent_tasks ("updatedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_version ON agent_tasks (version);

-- =========================================================================
-- Phase 4: DB-Side Monotonic Version Enforcement Trigger (P1-2 / P1-4)
-- =========================================================================
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

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_tasks_version_fence ON agent_tasks;
CREATE TRIGGER trg_agent_tasks_version_fence
    BEFORE UPDATE ON agent_tasks
    FOR EACH ROW
    EXECUTE FUNCTION trg_agent_tasks_monotonic_version();

-- =========================================================================
-- Phase 5: Row-Level Security (RLS) Configuration (N1 / C3 / C4 / P0-C)
-- =========================================================================
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;

-- 1. Service Role full access policy (for secure serverless API endpoints)
DROP POLICY IF EXISTS "Service role full access on agent_tasks" ON agent_tasks;
CREATE POLICY "Service role full access on agent_tasks"
    ON agent_tasks
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- 2. Drop any legacy public select policy that leaked tokens/PII
DROP POLICY IF EXISTS "Public task token access on agent_tasks" ON agent_tasks;
DROP POLICY IF EXISTS "Public read-only access for verification" ON agent_tasks;
DROP POLICY IF EXISTS "Clients can view own orders" ON agent_tasks;

-- 3. Authenticated clients can view only their own task records by JWT verified email
DROP POLICY IF EXISTS "Authenticated users can view own orders" ON agent_tasks;
CREATE POLICY "Authenticated users can view own orders"
    ON agent_tasks
    FOR SELECT
    TO authenticated
    USING (auth.jwt() ->> 'email' IS NOT NULL AND "userEmail" = (auth.jwt() ->> 'email'));

-- 4. Secure capability-token-based task lookup: anon users CANNOT list all rows, only view the specific row matching X-Task-Token
DROP POLICY IF EXISTS "Token holders can view specific task" ON agent_tasks;
CREATE POLICY "Token holders can view specific task"
    ON agent_tasks
    FOR SELECT
    TO anon, authenticated
    USING (
        "taskToken" IS NOT NULL
        AND "taskToken" = (nullif(current_setting('request.headers', true), '')::json->>'x-task-token')
    );

-- 5. Restricted INSERT Policy: anon users cannot spoof emails, bypass quantity caps, or manipulate financial fields (P0-C)
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
-- Phase 6: Double-Spend Prevention Ledger Tables (Claude Spec)
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
-- Phase 7: Atomic Settlement RPC (Claude Spec: CAS + Ledger in single TX)
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
-- Phase 8: Atomic Refund RPC (Claude Spec: Single TX CAS + Ledger)
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

    -- 5b. Check existing refund in payout_ledger on non-refunded task
    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_STALE_LEDGER_CONFLICT', 'message', 'Refund ledger already exists for non-refunded task');
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

-- =========================================================================
-- Phase 6: T+1 Hold, T+0 Deposit Guarantee, and Clawback Architecture
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

    UPDATE agent_tasks
    SET "settlementType" = 't1_default',
        "t1ReleaseAt" = COALESCE("createdAt", NOW()) + INTERVAL '24 hours',
        version = COALESCE(version, 0) + 1
    WHERE "t1ReleaseAt" IS NULL;
END $$;

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

CREATE TABLE IF NOT EXISTS platform_reserve_account (
    id TEXT PRIMARY KEY DEFAULT 'PLATFORM_MAIN_RESERVE',
    balance_usd NUMERIC(12, 2) NOT NULL DEFAULT 5000.00 CHECK (balance_usd >= 0.00),
    max_advance_per_task NUMERIC(10, 2) NOT NULL DEFAULT 100.00,
    max_advance_per_developer NUMERIC(10, 2) NOT NULL DEFAULT 300.00,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

ALTER TABLE payout_ledger DROP CONSTRAINT IF EXISTS payout_ledger_kind_check;
ALTER TABLE payout_ledger ADD CONSTRAINT payout_ledger_kind_check CHECK (kind IN ('escrow', 'settle', 'refund', 'clawback'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_single_clawback ON payout_ledger(task_id) WHERE kind = 'clawback';

-- Update acp_settle_task with T+1 hold
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
    SELECT status, "payoutStatus", version, "budgetUsd", "t1ReleaseAt", "acceptedByCustomerAt"
      INTO v_old_status, v_old_payout, v_old_ver, v_budget_usd, v_t1_release, v_accepted_at
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_TASK_NOT_FOUND', 'message', 'Task not found');
    END IF;

    IF v_old_status = 'verified' AND v_old_payout = 'settled' THEN
        RETURN jsonb_build_object('success', true, 'code', 'ALREADY_SETTLED', 'idempotent', true);
    END IF;

    IF v_old_ver != p_expected_version THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_VERSION_CONFLICT', 'message', 'Version conflict');
    END IF;

    IF v_old_status NOT IN ('delivered', 'completed') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_SETTLEMENT_STATE', 'message', 'Cannot settle in current status');
    END IF;

    IF v_old_payout = 'settled' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_ALREADY_SETTLED', 'message', 'Payout already settled');
    END IF;
    IF v_old_payout = 'refunded' OR v_old_status = 'refunded' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds have been refunded, settlement rejected');
    END IF;

    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'refund') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_SETTLEMENT_BLOCKED_BY_REFUND', 'message', 'Task funds have been refunded, settlement rejected');
    END IF;

    -- Check existing settle in payout_ledger on unverified task
    IF EXISTS (SELECT 1 FROM payout_ledger WHERE task_id = p_task_id AND kind = 'settle') THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_STALE_LEDGER_CONFLICT', 'message', 'Settle ledger already exists for unverified task');
    END IF;

    IF p_customer_accepted THEN
        v_accepted_at := v_now;
    ELSE
        IF v_t1_release IS NULL OR (v_now < v_t1_release AND v_accepted_at IS NULL) THEN
            RETURN jsonb_build_object(
                'success', false,
                'code', 'ACP_T1_HOLD_ACTIVE',
                'message', 'Settlement is protected under T+1 hold until ' || COALESCE(v_t1_release::text, 'expiration'),
                't1_release_at', v_t1_release
            );
        END IF;
    END IF;

    IF v_budget_usd IS NULL OR v_budget_usd <= 0 THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_INVALID_BUDGET', 'message', 'Task lacks authoritative budgetUsd');
    END IF;
    v_actual_amount := v_budget_usd;

    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'verified',
           "payoutStatus" = 'settled',
           "acceptedByCustomerAt" = COALESCE("acceptedByCustomerAt", v_accepted_at),
           version = v_next_ver,
           "updatedAt" = v_now
     WHERE id = p_task_id;

    INSERT INTO payout_ledger (task_id, kind, amount)
    VALUES (p_task_id, 'settle', v_actual_amount);

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

-- Atomic T+0 RPC
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

    SELECT available_deposit
      INTO v_avail_deposit
      FROM developer_guarantee_deposits
     WHERE developer_id = p_developer_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_NO_DEPOSIT_ACCOUNT', 'message', 'Developer has no guarantee deposit account');
    END IF;

    IF v_avail_deposit < v_budget_usd THEN
        RETURN jsonb_build_object(
            'success', false,
            'code', 'ACP_INSUFFICIENT_DEPOSIT',
            'message', 'Available deposit balance ($' || v_avail_deposit || ') is less than task amount ($' || v_budget_usd || ')'
        );
    END IF;

    UPDATE developer_guarantee_deposits
       SET available_deposit = available_deposit - v_budget_usd,
           locked_deposit = locked_deposit + v_budget_usd,
           updated_at = v_now
     WHERE developer_id = p_developer_id;

    INSERT INTO task_t0_deposit_locks (task_id, developer_id, locked_amount, status, created_at, updated_at)
    VALUES (p_task_id, p_developer_id, v_budget_usd, 'locked', v_now, v_now);

    INSERT INTO deposit_ledger (developer_id, task_id, kind, amount, created_at)
    VALUES (p_developer_id, p_task_id, 't0_lock', v_budget_usd, v_now);

    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'verified',
           "payoutStatus" = 'settled',
           "settlementType" = 't0_guaranteed',
           version = v_next_ver,
           "updatedAt" = v_now
     WHERE id = p_task_id;

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

-- Release Expired Locked Guarantee Deposits
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

    SELECT "t1ReleaseAt"
      INTO v_t1_release
      FROM agent_tasks
     WHERE id = p_task_id;

    IF v_t1_release IS NULL OR v_now < v_t1_release THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_DISPUTE_WINDOW_ACTIVE', 'message', 'Dispute window is still active or undefined');
    END IF;

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

-- Atomic Clawback RPC
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

    v_next_ver := v_old_ver + 1;
    UPDATE agent_tasks
       SET status = 'disputed',
           "payoutStatus" = 'clawed_back',
           version = v_next_ver,
           "updatedAt" = v_now
     WHERE id = p_task_id;

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
