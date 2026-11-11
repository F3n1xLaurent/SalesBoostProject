import React from 'react';
import * as Primitive from '@radix-ui/react-tooltip';
import { CircleHelp } from 'lucide-react';
export function Formula({ children }: {
  children: React.ReactNode;
}) {
  return <Primitive.Provider delayDuration={150}><Primitive.Root><Primitive.Trigger asChild><button type="button" className="av-help" aria-label="Как считаем"><CircleHelp size={14} /></button></Primitive.Trigger><Primitive.Portal><Primitive.Content className="av-tooltip" sideOffset={6}><strong>Как считаем</strong><div>{children}</div><Primitive.Arrow /></Primitive.Content></Primitive.Portal></Primitive.Root></Primitive.Provider>;
}
