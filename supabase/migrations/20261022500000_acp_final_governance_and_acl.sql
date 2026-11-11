-- 20261022500000_acp_final_governance_and_acl.sql
-- Production Forward Migration: ACP Final Governance, Universal ACL Lockdown & T+0 NULL Guard
-- Idempotent, safe to re-run.

-- 1. DROP obsolete 3-argument acp_settle_task overload to prevent signature confusion
DROP FUNCTION IF EXISTS public.acp_settle_task(TEXT, INTEGER, NUMERIC);

-- 2. Harden acp_release_expired_locked_deposits with strict NULL fail-close guard
CREATE OR REPLACE FUNCTION public.acp_release_expired_locked_deposits(p_task_id TEXT)
RETURNS JSONB AS $$
DECLARE
    v_dev_id TEXT;
    v_locked_amt NUMERIC;
    v_lock_status TEXT;
    v_t1_release TIMESTAMPTZ;
    v_dispute_deadline TIMESTAMPTZ;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    SELECT developer_id, locked_amount, status
      INTO v_dev_id, v_locked_amt, v_lock_status
      FROM task_t0_deposit_locks
     WHERE task_id = p_task_id
       FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_LOCK_NOT_FOUND', 'message', 'Deposit lock record not found');
    END IF;

    IF v_lock_status != 'locked' THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_LOCK_NOT_ACTIVE', 'message', 'Deposit lock is not active');
    END IF;

    SELECT "t1ReleaseAt", "disputeDeadlineAt"
      INTO v_t1_release, v_dispute_deadline
      FROM agent_tasks
     WHERE id = p_task_id
       FOR UPDATE;

    -- Strict fail-close: if timestamps are NULL or window is still active, reject unlock
    IF v_t1_release IS NULL OR v_now < COALESCE(v_dispute_deadline, v_t1_release) THEN
        RETURN jsonb_build_object('success', false, 'code', 'ACP_DISPUTE_WINDOW_ACTIVE', 'message', 'Dispute window is still active or undefined');
    END IF;

    -- Unlock deposit
    UPDATE task_t0_deposit_locks
       SET status = 'released',
           updated_at = v_now
     WHERE task_id = p_task_id;

    UPDATE developer_guarantee_deposits
       SET locked_deposit = locked_deposit - v_locked_amt,
           available_deposit = available_deposit + v_locked_amt,
           updated_at = v_now
     WHERE developer_id = v_dev_id;

    INSERT INTO deposit_ledger (developer_id, task_id, kind, amount, created_at)
    VALUES (v_dev_id, p_task_id, 't0_unlock', v_locked_amt, v_now);

    RETURN jsonb_build_object('success', true, 'code', 'DEPOSIT_UNLOCKED', 'released_amount', v_locked_amt);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 3. Universal ACL Lockdown across ALL public.acp_% functions
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'acp\_%'
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', r.sig);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', r.sig);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM authenticated', r.sig);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END LOOP;
END $$;

-- 4. Explicit enforcement for 4-parameter acp_settle_task
REVOKE EXECUTE ON FUNCTION public.acp_settle_task(TEXT, INTEGER, NUMERIC, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acp_settle_task(TEXT, INTEGER, NUMERIC, BOOLEAN) TO service_role;

-- 5. Revoke default public execution privileges in public schema to prevent future leaks
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
