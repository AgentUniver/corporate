import { supabase } from './client';
import type { UserProfile } from './types';

/**
 * 触发 Google SSO 登录
 */
export async function signInWithGoogle() {
  if (supabase) {
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin + '/marketplace'
        }
      });
      if (error) throw error;
      return data;
    } catch (err) {
      console.warn('Supabase Google OAuth failed, activating demo fallback session:', err);
    }
  }

  // Local / Demo Fallback
  const mockUser: UserProfile = {
    id: 'usr-google-' + Date.now().toString(36),
    email: 'builder@gmail.com',
    name: 'Google Builder (Demo)',
    avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=GoogleBuilder',
    role: 'client'
  };
  localStorage.setItem('agentuniver_auth_user', JSON.stringify(mockUser));
  window.dispatchEvent(new Event('agentuniver_auth_change'));
  return { user: mockUser };
}

/**
 * 触发 GitHub OAuth 登录
 */
export async function signInWithGithub() {
  if (supabase) {
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'github',
        options: {
          redirectTo: window.location.origin + '/marketplace'
        }
      });
      if (error) throw error;
      return data;
    } catch (err) {
      console.warn('Supabase GitHub OAuth failed, activating demo fallback session:', err);
    }
  }

  // Local / Demo Fallback
  const mockUser: UserProfile = {
    id: 'usr-github-' + Date.now().toString(36),
    email: 'dev@github.com',
    name: 'GitHub Developer (Demo)',
    avatarUrl: 'https://api.dicebear.com/7.x/bottts/svg?seed=GitHubDev',
    role: 'developer'
  };
  localStorage.setItem('agentuniver_auth_user', JSON.stringify(mockUser));
  window.dispatchEvent(new Event('agentuniver_auth_change'));
  return { user: mockUser };
}

/**
 * 触发 Web3 钱包 (MetaMask / OKX) 登录
 */
export async function signInWithWeb3Wallet(): Promise<{ user: UserProfile } | null> {
  if (typeof window !== 'undefined' && typeof (window as any).ethereum !== 'undefined') {
    try {
      const accounts = await (window as any).ethereum.request({ method: 'eth_requestAccounts' });
      if (accounts && accounts.length > 0) {
        const acc = accounts[0];
        localStorage.setItem('agentuniver_wallet', acc);
        const web3User: UserProfile = {
          id: 'did:eth:' + acc,
          email: `${acc.substring(0, 6)}...${acc.substring(acc.length - 4)}@web3.eth`,
          name: `${acc.substring(0, 6)}...${acc.substring(acc.length - 4)}`,
          avatarUrl: `https://api.dicebear.com/7.x/identicon/svg?seed=${acc}`,
          role: 'developer'
        };
        localStorage.setItem('agentuniver_auth_user', JSON.stringify(web3User));
        window.dispatchEvent(new Event('agentuniver_auth_change'));
        window.dispatchEvent(new CustomEvent('agentuniver_wallet_connected', { detail: { address: acc } }));
        return { user: web3User };
      }
    } catch (err: any) {
      console.warn('Web3 wallet connection rejected:', err);
      throw err;
    }
  }

  // No Web3 wallet found
  if (typeof window !== 'undefined') {
    if ((window as any).showPageAlert) {
      (window as any).showPageAlert({
        type: 'warning',
        title: 'Web3 Wallet Required',
        message: 'No Web3 wallet detected. Please install MetaMask or OKX Wallet to connect your decentralized identity.',
        action: {
          label: 'Install MetaMask',
          url: 'https://metamask.io/download/'
        },
        duration: 7000
      });
    }
  }
  return null;
}

/**
 * 登出
 */
export async function signOutUser() {
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch (err) {
      console.warn('Supabase signOut failed:', err);
    }
  }
  localStorage.removeItem('agentuniver_auth_user');
  window.dispatchEvent(new Event('agentuniver_auth_change'));
}

/**
 * 获取当前登录用户
 */
export async function getCurrentUserProfile(): Promise<UserProfile | null> {
  if (supabase) {
    try {
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
    } catch (err) {
      console.warn('Supabase getUser failed, reading cached fallback profile:', err);
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
