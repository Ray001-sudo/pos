// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: process.env.VITE_API_URL || 'http://localhost:3000',
                changeOrigin: true,
                secure: false
            }
        }
    },
    build: {
        outDir: 'dist',
        sourcemap: false,   // No source maps in production builds
        rollupOptions: {
            output: {
                manualChunks: {
                    vendor:   ['react', 'react-dom', 'react-router-dom'],
                    charts:   ['recharts'],
                    ui:       ['@headlessui/react', 'lucide-react', 'clsx'],
                    query:    ['@tanstack/react-query'],
                    state:    ['zustand'],
                    http:     ['axios']
                }
            }
        }
    }
});
