import React, { useState, useEffect, createContext, useContext } from 'react';

const SIDEBAR_WIDTH_PX = 260;

const DrawerContext = createContext<{ closeDrawer: () => void } | null>(null);
export function useAdminDrawer() {
  return useContext(DrawerContext);
}

type AdminLayoutProps = {
  sidebar: React.ReactNode;
  content: React.ReactNode;
  pageTitle?: string;
};

export function AdminLayout({ sidebar, content, pageTitle = '' }: AdminLayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const onResize = () => {
      if (window.innerWidth >= 768) setDrawerOpen(false);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mounted]);

  const closeDrawer = () => setDrawerOpen(false);

  return (
    <div className="admin-app" data-ui-version="2">
      {/* Desktop: persistent sidebar */}
      <aside
        className="admin-sidebar"
        style={{
          width: SIDEBAR_WIDTH_PX,
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 40,
          overflowY: 'auto',
          transition: 'transform var(--transition-ui), box-shadow var(--transition-ui)',
        }}
      >
        <DrawerContext.Provider value={{ closeDrawer }}>
          <div className="admin-sidebar-inner" style={{ padding: '20px 14px' }}>
            {sidebar}
          </div>
        </DrawerContext.Provider>
      </aside>

      {/* Mobile: drawer overlay */}
      {mounted && (
        <>
          <div
            role="presentation"
            onClick={closeDrawer}
            style={{
              position: 'fixed',
              inset: 0,
              background: 'rgba(0,0,0,0.3)',
              zIndex: 50,
              opacity: drawerOpen ? 1 : 0,
              pointerEvents: drawerOpen ? 'auto' : 'none',
              transition: 'opacity var(--transition-fast)',
            }}
            aria-hidden="true"
          />
          <aside
            className="admin-drawer"
            style={{
              position: 'fixed',
              left: 0,
              top: 0,
              bottom: 0,
              width: SIDEBAR_WIDTH_PX,
              maxWidth: '85vw',
              zIndex: 51,
              overflowY: 'auto',
              transform: drawerOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform var(--transition-ui)',
              boxShadow: drawerOpen ? 'var(--shadow-popover)' : 'none',
            }}
          >
            <DrawerContext.Provider value={{ closeDrawer }}>
              <div className="admin-sidebar-inner" style={{ padding: '20px 14px', paddingTop: 56 }}>
                {sidebar}
              </div>
            </DrawerContext.Provider>
          </aside>
        </>
      )}

      {/* Main content — отступ и ширина заданы явно в px, чтобы контент не заходил на сайдбар */}
      <main
        className="admin-main"
        style={{
          marginLeft: SIDEBAR_WIDTH_PX,
          width: `calc(100% - ${SIDEBAR_WIDTH_PX}px)`,
          minWidth: 0,
          minHeight: '100vh',
          boxSizing: 'border-box',
          flexShrink: 0,
          transition: 'margin-left var(--transition-fast), width var(--transition-fast)',
        }}
      >
        {/* Mobile top bar */}
        <header
          className="admin-topbar"
          style={{
            display: 'none',
            position: 'sticky',
            top: 0,
            zIndex: 30,
            background: 'var(--bg-card)',
            padding: '12px 16px',
            boxShadow: 'var(--shadow-card)',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Открыть меню"
            className="admin-sidebar-nav-item"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 44,
              height: 44,
              border: 'none',
              background: 'var(--bg-sidebar)',
              borderRadius: 'var(--radius-control)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              transition: 'background var(--transition-ui)',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>
            {pageTitle || 'Админ‑панель'}
          </h1>
        </header>

        <div className="admin-content">
          <header className="admin-page-header" style={{ marginBottom: 24, display: 'none' }}>
            <h1>
              {pageTitle || 'Админ‑панель'}
            </h1>
          </header>
          {content}
        </div>
      </main>

      <style>{`
        /* Жёсткое отделение контента от сайдбара — переопределить нельзя */
        .admin-app[data-ui-version="2"] > .admin-main {
          margin-left: ${SIDEBAR_WIDTH_PX}px !important;
          width: calc(100% - ${SIDEBAR_WIDTH_PX}px) !important;
          max-width: calc(100vw - ${SIDEBAR_WIDTH_PX}px);
          border-left: 1px solid var(--border-subtle, #ECECEC);
        }
        @media (min-width: 768px) {
          .admin-page-header { display: block !important; }
        }
        @media (max-width: 767px) {
          .admin-sidebar { transform: translateX(-100%); }
          .admin-app[data-ui-version="2"] > .admin-main {
            margin-left: 0 !important;
            width: 100% !important;
            max-width: 100%;
            border-left: none;
          }
          .admin-topbar { display: flex !important; }
          .admin-content { padding: 16px !important; }
        }
      `}</style>
    </div>
  );
}

export function AdminSidebarNavItem(props: {
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const { active, onClick, children, icon } = props;
  return (
    <button
      type="button"
      className="admin-sidebar-nav-item"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        minHeight: 44,
        padding: '10px 14px',
        marginBottom: 4,
        border: 'none',
        borderRadius: 'var(--radius-control)',
        background: active ? 'var(--bg-card)' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-primary)',
        fontWeight: active ? 600 : 400,
        fontSize: 14,
        cursor: 'pointer',
        textAlign: 'left',
        boxShadow: active ? 'var(--shadow-card)' : 'none',
        transition: 'background var(--transition-ui), color var(--transition-ui), box-shadow var(--transition-ui)',
      }}
      onMouseOver={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--hover-bg)';
        }
      }}
      onMouseOut={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      {icon && <span style={{ flexShrink: 0 }}>{icon}</span>}
      <span>{children}</span>
    </button>
  );
}
