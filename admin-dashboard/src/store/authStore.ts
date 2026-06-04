// =============================================================================
// src/store/authStore.ts — Zustand authentication store
// =============================================================================
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api from '../api/client';

interface User {
    user_id:   string;
    tenant_id: string;
    role:      string;
    modules:   string[];
}

interface AuthState {
    user:          User | null;
    accessToken:   string | null;
    isAuthenticated: boolean;
    login:  (tenantId: string, username: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
    setToken: (token: string) => void;
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set, get) => ({
            user:            null,
            accessToken:     null,
            isAuthenticated: false,

            login: async (tenantId, username, password) => {
                const response = await api.post('/auth/login', {
                    tenant_id: tenantId,
                    username,
                    password
                });
                const { access_token, role } = response.data;

                // Decode JWT payload (base64) to extract user info
                const payload = JSON.parse(atob(access_token.split('.')[1]));

                api.defaults.headers.common['Authorization'] = `Bearer ${access_token}`;

                set({
                    accessToken:     access_token,
                    isAuthenticated: true,
                    user: {
                        user_id:   payload.user_id,
                        tenant_id: payload.tenant_id,
                        role:      payload.role,
                        modules:   payload.modules || []
                    }
                });
            },

            logout: async () => {
                try {
                    await api.post('/auth/logout');
                } catch (_) {}
                delete api.defaults.headers.common['Authorization'];
                set({ user: null, accessToken: null, isAuthenticated: false });
            },

            setToken: (token) => {
                api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
                set({ accessToken: token });
            }
        }),
        { name: 'pos-auth', partialize: (s) => ({ accessToken: s.accessToken, user: s.user }) }
    )
);
