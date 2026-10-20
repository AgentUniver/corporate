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
-- Phase 2: Constraint Rebuilding (NOT VALID)
-- =========================================================================
DO $$
BEGIN
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

    -- 2. PayoutStatus Check Constraint Rebuild
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_payoutStatus_check";
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_payoutStatus_check;
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_payoutstatus_check;
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS check_agent_tasks_payout_status;
    ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_payoutStatus_check" CHECK (
        "payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled', 'refunded', 'failed')
    ) NOT VALID;

    -- 3. Exhaustive State Machine Ledger Consistency Check (P0-B / P1-1 / P1-3)
    -- Enforces payoutStatus IS NOT NULL on terminal verified/completed/refunded, while allowing disputed settlements and cancelled tasks
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_status_payout_consistency_check";
    ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_status_payout_consistency_check" CHECK (
        (status = 'pending' AND ("payoutStatus" IS NULL OR "payoutStatus" = 'pending'))
        OR (status = 'escrowed' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed')))
        OR (status = 'processing' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed')))
        OR (status = 'delivered' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed')))
        OR (status = 'disputed' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled', 'refunded', 'failed')))
        OR (status = 'verified' AND "payoutStatus" IS NOT NULL AND "payoutStatus" IN ('settled', 'escrowed'))
        OR (status = 'completed' AND "payoutStatus" IS NOT NULL AND "payoutStatus" IN ('settled', 'escrowed'))
        OR (status = 'refunded' AND "payoutStatus" IS NOT NULL AND "payoutStatus" = 'refunded')
        OR (status = 'failed' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('refunded', 'failed')))
        OR (status = 'cancelled' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('refunded', 'failed', 'settled')))
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
-- Phase 4: DB-Side Monotonic Version Enforcement Trigger (P1-2)
-- =========================================================================
CREATE OR REPLACE FUNCTION trg_agent_tasks_monotonic_version()
RETURNS TRIGGER AS $$
BEGIN
    -- 1. Monotonic version fencing (P1-2)
    IF NEW.version IS NULL OR NEW.version <= OLD.version THEN
        RAISE EXCEPTION 'Monotonic version violation: NEW.version (%) must be strictly greater than OLD.version (%)', NEW.version, OLD.version;
    END IF;

    -- 2. Terminal state immutability (P1-6): verified, completed, refunded, cancelled are irreversible
    IF OLD.status IN ('verified', 'completed', 'refunded', 'cancelled') AND NEW.status != OLD.status THEN
        RAISE EXCEPTION 'Terminal state immutability violation: Cannot transition task from terminal status % to %', OLD.status, NEW.status;
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
