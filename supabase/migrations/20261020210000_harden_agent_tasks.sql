-- Migration: 20261020210000_harden_agent_tasks.sql
-- Description: Harden agent_tasks trigger for terminal state immutability (P1-6) and anon RLS null userEmail (P1-3)

-- 1. Upgrade monotonic version function to enforce terminal state immutability
CREATE OR REPLACE FUNCTION trg_agent_tasks_monotonic_version()
RETURNS TRIGGER AS $$
BEGIN
    -- Monotonic version fencing (P1-2)
    IF NEW.version IS NULL OR NEW.version <= OLD.version THEN
        RAISE EXCEPTION 'Monotonic version violation: NEW.version (%) must be strictly greater than OLD.version (%)', NEW.version, OLD.version;
    END IF;

    -- Terminal state immutability (P1-6): verified, completed, refunded, cancelled are irreversible
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
