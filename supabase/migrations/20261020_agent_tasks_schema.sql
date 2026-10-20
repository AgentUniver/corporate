-- Migration: 20261020_agent_tasks_schema.sql
-- Description: Canonical schema definition for agent_tasks with strict status CHECK constraints, secure RLS policies, and indexes.

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
    agent_slug TEXT
);

-- Idempotent Column Additions & Constraint Rebuilding for Pre-existing Tables
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

    -- 2. Status Check Constraint Rebuild
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
            'completed'
        )
    );
    ALTER TABLE agent_tasks ALTER COLUMN status SET DEFAULT 'escrowed';

    -- 3. PayoutStatus Check Constraint Rebuild (Handle both quoted mixed-case and unquoted lowercase)
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS "agent_tasks_payoutStatus_check";
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_payoutStatus_check;
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_payoutstatus_check;
    ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS check_agent_tasks_payout_status;
    ALTER TABLE agent_tasks ADD CONSTRAINT "agent_tasks_payoutStatus_check" CHECK (
        "payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed', 'settled', 'refunded', 'failed')
    );
END $$;

-- Indexes for high-frequency queries and joins
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks (status);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_agent_id ON agent_tasks ("agentId");
CREATE INDEX IF NOT EXISTS idx_agent_tasks_task_token ON agent_tasks ("taskToken");
CREATE INDEX IF NOT EXISTS idx_agent_tasks_created_at ON agent_tasks ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated_at ON agent_tasks ("updatedAt" DESC);

-- Row-Level Security (RLS) Configuration
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

-- 3. Anonymous & Authenticated web clients can insert new orders in escrowed/pending status with restricted financial defaults
DROP POLICY IF EXISTS "Clients can insert new orders" ON agent_tasks;
CREATE POLICY "Clients can insert new orders"
    ON agent_tasks
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (
        status IN ('pending', 'escrowed')
        AND ("payoutStatus" IS NULL OR "payoutStatus" = 'pending' OR "payoutStatus" = 'escrowed')
        AND "budgetUsd" >= 0.05
        AND "budgetUsd" <= 10000.00
        AND "platformFeeUsd" >= 0
        AND "taskToken" IS NULL
        AND "payoutAddress" IS NULL
        AND "payoutTxHash" IS NULL
        AND "deliverableFingerprint" IS NULL
        AND "arbitrationVerdict" IS NULL
        AND "resultPayload" IS NULL
    );

-- 4. Authenticated clients can view only their own task records by email match
DROP POLICY IF EXISTS "Authenticated users can view own orders" ON agent_tasks;
CREATE POLICY "Authenticated users can view own orders"
    ON agent_tasks
    FOR SELECT
    TO authenticated
    USING (auth.jwt() ->> 'email' = "userEmail");
