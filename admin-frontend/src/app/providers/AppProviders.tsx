import { HeroUIProvider } from '@heroui/react';
import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { ToastProvider } from '../../shared/ui/toast/ToastProvider';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      <HeroUIProvider>
        <ToastProvider>
          {children}
        </ToastProvider>
      </HeroUIProvider>
    </BrowserRouter>
  );
}
