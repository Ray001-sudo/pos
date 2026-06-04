// =============================================================================
// src/api/client.ts — Axios instance with JWT refresh interceptor
// =============================================================================
import axios, { AxiosInstance, AxiosError } from 'axios';

const BASE_URL = import.meta.env.VITE_API_URL || 'https://api.yourdomain.com/api/v1';

const api: AxiosInstance = axios.create({
    baseURL:         BASE_URL,
    withCredentials: true,    // send httpOnly refresh token cookie
    timeout:         15000,
    headers: { 'Content-Type': 'application/json' }
});

// Inject stored token on startup
const stored = localStorage.getItem('pos-auth');
if (stored) {
    try {
        const parsed = JSON.parse(stored);
        if (parsed?.state?.accessToken) {
            api.defaults.headers.common['Authorization'] = `Bearer ${parsed.state.accessToken}`;
        }
    } catch (_) {}
}

// -----------------------------------------------------------------------
// Response interceptor: on 401, attempt one token refresh
// -----------------------------------------------------------------------
let isRefreshing = false;
let failedQueue: Array<{ resolve: (v: string) => void; reject: (e: unknown) => void }> = [];

function processQueue(error: unknown, token: string | null = null) {
    failedQueue.forEach(({ resolve, reject }) => {
        if (error) reject(error);
        else resolve(token!);
    });
    failedQueue = [];
}

api.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const originalRequest = error.config as typeof error.config & { _retry?: boolean };

        if (error.response?.status === 401 && !originalRequest._retry) {
            if (isRefreshing) {
                return new Promise((resolve, reject) => {
                    failedQueue.push({ resolve, reject });
                }).then((token) => {
                    originalRequest.headers!['Authorization'] = `Bearer ${token}`;
                    return api(originalRequest);
                });
            }

            originalRequest._retry = true;
            isRefreshing = true;

            try {
                const { data } = await axios.post(
                    `${BASE_URL}/auth/refresh`,
                    {},
                    { withCredentials: true }
                );
                const newToken = data.access_token;

                api.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
                processQueue(null, newToken);

                // Update persisted store
                const stored = localStorage.getItem('pos-auth');
                if (stored) {
                    const p = JSON.parse(stored);
                    p.state.accessToken = newToken;
                    localStorage.setItem('pos-auth', JSON.stringify(p));
                }

                originalRequest.headers!['Authorization'] = `Bearer ${newToken}`;
                return api(originalRequest);
            } catch (refreshErr) {
                processQueue(refreshErr, null);
                // Redirect to login
                window.location.href = '/login';
                return Promise.reject(refreshErr);
            } finally {
                isRefreshing = false;
            }
        }

        return Promise.reject(error);
    }
);

export default api;
