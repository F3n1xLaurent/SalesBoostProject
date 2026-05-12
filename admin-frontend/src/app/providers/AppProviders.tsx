import { HeroUIProvider } from '@heroui/react';
import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <BrowserRouter>
      <HeroUIProvider>
        {children}
      </HeroUIProvider>
    </BrowserRouter>
  );
}
