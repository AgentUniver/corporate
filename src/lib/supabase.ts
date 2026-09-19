/**
 * AgentUniver Supabase Service Layer (Modular Facade)
 * 
 * Re-exports submodules across types, client, auth, tasks, pulse, and accounting.
 * Strictly enforces environment-based configuration without plaintext secrets.
 */

export * from './supabase/types';
export * from './supabase/client';
export * from './supabase/pulse';
export * from './supabase/auth';
export * from './supabase/tasks';
export * from './supabase/accounting';
