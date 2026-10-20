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

        -- Pre-repair legacy dirty status/payoutStatus pairs to ensure full validity
        UPDATE agent_tasks SET "payoutStatus" = 'failed' WHERE status = 'failed' AND ("payoutStatus" IS NULL OR "payoutStatus" NOT IN ('refunded', 'failed'));
        UPDATE agent_tasks SET "payoutStatus" = 'cancelled' WHERE status = 'cancelled' AND ("payoutStatus" IS NULL OR "payoutStatus" IN ('pending', 'escrowed'));
        UPDATE agent_tasks SET "payoutStatus" = 'refunded' WHERE status = 'refunded' AND ("payoutStatus" IS NULL OR "payoutStatus" != 'refunded');
        UPDATE agent_tasks SET "payoutStatus" = 'settled' WHERE status IN ('verified', 'completed') AND ("payoutStatus" IS NULL OR "payoutStatus" NOT IN ('settled', 'escrowed'));
        UPDATE agent_tasks SET "payoutStatus" = 'escrowed' WHERE status = 'delivered' AND "payoutStatus" = 'settled';
    END IF;
END $$;

-- 1. Upgrade monotonic version function to enforce terminal state immutability (P1-4 / P0-3)
CREATE OR REPLACE FUNCTION trg_agent_tasks_monotonic_version()
RETURNS TRIGGER AS $$
BEGIN
    -- Monotonic version fencing (P1-2)
    IF NEW.version IS NULL OR (OLD.version IS NOT NULL AND NEW.version <= OLD.version) THEN
        RAISE EXCEPTION 'Monotonic version violation: NEW.version (%) must be strictly greater than OLD.version (%)', NEW.version, OLD.version;
    END IF;

    -- Terminal states cannot revert to active workflow states (P1-4 / P0-3: completed removed to permit dispute/settle)
    IF OLD.status IN ('verified', 'refunded', 'cancelled') 
       AND NEW.status IN ('pending', 'escrowed', 'processing') THEN
        RAISE EXCEPTION 'Terminal state immutability violation: Cannot transition task from terminal status % to %', OLD.status, NEW.status;
    END IF;

    -- Hard terminal states (refunded, cancelled) are completely irreversible
    IF OLD.status IN ('refunded', 'cancelled') AND NEW.status != OLD.status THEN
        RAISE EXCEPTION 'Terminal state immutability violation: % status is irreversible', OLD.status;
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
