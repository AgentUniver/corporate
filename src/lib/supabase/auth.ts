import { supabase } from './client';
import type { UserProfile } from './types';

/**
 * 触发 Google SSO 登录
 */
export async function signInWithGoogle() {
  if (supabase) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/marketplace'
      }
    });
    if (error) throw error;
    return data;
  } else {
    // Local / Demo Fallback
    const mockUser: UserProfile = {
      id: 'usr-google-' + Date.now().toString(36),
      email: 'builder@gmail.com',
      name: 'Google Builder',
      avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=GoogleBuilder',
      role: 'client'
    };
    localStorage.setItem('agentuniver_auth_user', JSON.stringify(mockUser));
    window.dispatchEvent(new Event('agentuniver_auth_change'));
    return { user: mockUser };
  }
}

/**
 * 触发 GitHub OAuth 登录
 */
export async function signInWithGithub() {
  if (supabase) {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        redirectTo: window.location.origin + '/marketplace'
      }
    });
    if (error) throw error;
    return data;
  } else {
    // Local / Demo Fallback
    const mockUser: UserProfile = {
      id: 'usr-github-' + Date.now().toString(36),
      email: 'dev@github.com',
      name: 'GitHub Developer',
      avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=GitHubDev',
      role: 'developer'
    };
    localStorage.setItem('agentuniver_auth_user', JSON.stringify(mockUser));
    window.dispatchEvent(new Event('agentuniver_auth_change'));
    return { user: mockUser };
  }
}

/**
 * 登出
 */
export async function signOutUser() {
  if (supabase) {
    await supabase.auth.signOut();
  }
  localStorage.removeItem('agentuniver_auth_user');
  window.dispatchEvent(new Event('agentuniver_auth_change'));
}

/**
 * 获取当前登录用户
 */
export async function getCurrentUserProfile(): Promise<UserProfile | null> {
  if (supabase) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      return {
        id: user.id,
        email: user.email || '',
        name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Agent Builder',
        avatarUrl: user.user_metadata?.avatar_url || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + user.id,
        role: 'client'
      };
    }
  }
  
  if (typeof window !== 'undefined') {
    const cached = localStorage.getItem('agentuniver_auth_user');
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}
