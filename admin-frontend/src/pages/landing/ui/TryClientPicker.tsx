import { useEffect, useRef, type CSSProperties } from 'react';
import { Orb } from '@/components/ui/orb';
import { useDemoClients, type TryClientId } from '../lib/tryClients';

type TryClientPickerProps = {
  value: TryClientId;
  onChange: (id: TryClientId) => void;
};

export function TryClientPicker({ value, onChange }: TryClientPickerProps) {
  const clients = useDemoClients();
  const pickerRef = useRef<HTMLDivElement>(null);
  const firstCenter = useRef(true);
  const selectFromScroll = useRef(false);
  const lockScrollSync = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;

  const centerActive = (smooth: boolean) => {
    const root = pickerRef.current;
    if (!root || root.scrollWidth <= root.clientWidth + 8) return;
    const active = root.querySelector<HTMLElement>('.is-active');
    if (!active) return;
    const left = active.offsetLeft - (root.clientWidth - active.offsetWidth) / 2;
    if (smooth) {
      root.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
    } else {
      root.scrollLeft = Math.max(0, left);
    }
  };

  const nearestClient = () => {
    const root = pickerRef.current;
    if (!root) return 0;
    const mid = root.getBoundingClientRect().left + root.clientWidth / 2;
    const nodes = root.querySelectorAll<HTMLElement>('.sl-try-client');
    let best = 0;
    let dist = Infinity;
    nodes.forEach((el, i) => {
      const box = el.getBoundingClientRect();
      const d = Math.abs(box.left + box.width / 2 - mid);
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return best;
  };

  useEffect(() => {
    if (selectFromScroll.current) {
      selectFromScroll.current = false;
      return;
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        centerActive(!firstCenter.current);
        firstCenter.current = false;
      });
    });
    const unlock = window.setTimeout(() => {
      lockScrollSync.current = false;
    }, 360);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(unlock);
    };
  }, [value]);

  useEffect(() => {
    const root = pickerRef.current;
    if (!root) return;

    let frame = 0;
    const sync = () => {
      frame = 0;
      const next = nearestClient();
      if (lockScrollSync.current) {
        if (clients[next]?.id === valueRef.current) lockScrollSync.current = false;
        return;
      }
      const nextId = clients[next]?.id;
      if (!nextId || nextId === valueRef.current) return;
      selectFromScroll.current = true;
      onChange(nextId);
    };
    const onScroll = () => {
      if (lockScrollSync.current) return;
      if (frame) return;
      frame = requestAnimationFrame(sync);
    };

    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener('scroll', onScroll);
    };
  }, [clients, onChange]);

  useEffect(() => {
    const recenter = () => centerActive(false);
    window.addEventListener('resize', recenter);
    window.addEventListener('load', recenter);

    const root = pickerRef.current;
    let observer: ResizeObserver | undefined;
    if (root && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        recenter();
      });
      observer.observe(root);
    }

    const lateRecenter = window.setTimeout(() => recenter(), 120);

    return () => {
      window.clearTimeout(lateRecenter);
      observer?.disconnect();
      window.removeEventListener('resize', recenter);
      window.removeEventListener('load', recenter);
    };
  }, []);

  return (
    <div ref={pickerRef} className="sl-try-picker" role="radiogroup" aria-label="Выберите AI-клиента">
      {clients.map((c) => {
        const isActive = c.id === value;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`sl-try-client${isActive ? ' is-active' : ''}`}
            style={{ '--sl-client-ring': c.ring } as CSSProperties}
            onClick={() => {
              lockScrollSync.current = true;
              onChange(c.id);
            }}
          >
            <span className="sl-try-client-orb" aria-hidden>
              <span className="sl-try-client-orb-core">
                <Orb colors={c.colors} seed={c.seed} agentState="talking" />
              </span>
            </span>
            <strong>{c.name}</strong>
            <em>{c.temper}</em>
          </button>
        );
      })}
    </div>
  );
}
