import Link from 'next/link';
import { cookies } from 'next/headers';
import { COOKIE_NAME, verifyJwtToken } from '@/lib/auth';

export default async function Home() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const isLoggedIn = token ? !!(await verifyJwtToken(token)) : false;

  return (
    <div style={{ minHeight: '100vh', color: 'var(--text-primary)', fontFamily: 'var(--font-ui)', display: 'flex', flexDirection: 'column' }}>

      {/* Top Navigation Bar */}
      <header style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        padding: '0 32px',
        height: '52px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 40,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '28px', height: '28px', borderRadius: '6px',
            background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, color: '#0d1117', fontSize: '13px',
          }}>C</div>
          <span style={{ fontWeight: 700, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>CraftControl</span>
          <span style={{
            fontSize: '0.65rem', padding: '2px 7px', borderRadius: '4px',
            background: 'var(--accent-dim)', border: '1px solid var(--accent-border)',
            color: 'var(--accent)', fontWeight: 600, letterSpacing: '0.05em',
          }}>v1.0</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {!isLoggedIn && (
            <Link href="/login" style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', textDecoration: 'none', fontWeight: 500 }}>
              Sign In
            </Link>
          )}
          <Link href="/dashboard" className="cc-btn-primary" style={{ textDecoration: 'none', display: 'inline-block' }}>
            Dashboard
          </Link>
        </div>
      </header>

      {/* Hero */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '80px 32px 60px', textAlign: 'center' }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '8px',
          padding: '4px 14px', borderRadius: '20px',
          background: 'var(--accent-dim)', border: '1px solid var(--accent-border)',
          fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)',
          letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '28px',
        }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
          Split Architecture Control Plane
        </div>

        <h1 style={{
          fontSize: 'clamp(2rem, 5vw, 3.5rem)',
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: '-0.02em',
          marginBottom: '20px',
          maxWidth: '780px',
          background: 'linear-gradient(135deg, #e6edf3 0%, #8b949e 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          Modern, Distributed Minecraft Server Management
        </h1>

        <p style={{ color: 'var(--text-muted)', fontSize: '1.0625rem', maxWidth: '560px', lineHeight: 1.75, marginBottom: '40px' }}>
          Manage remote Minecraft daemon nodes wirelessly, deploy Modrinth modpacks in 1-click, and grant role-based access control to your team.
        </p>

        <div style={{ display: 'flex', gap: '12px', marginBottom: '80px', flexWrap: 'wrap', justifyContent: 'center' }}>
          <Link href="/dashboard" className="cc-btn-primary" style={{ textDecoration: 'none', padding: '10px 24px', fontSize: '0.875rem', borderRadius: '8px' }}>
            Open Dashboard →
          </Link>
          {!isLoggedIn && (
            <Link href="/login" className="cc-btn-ghost" style={{ textDecoration: 'none', padding: '10px 24px', fontSize: '0.875rem', borderRadius: '8px' }}>
              Sign In
            </Link>
          )}
        </div>

        {/* Feature Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px', width: '100%', maxWidth: '900px', textAlign: 'left' }}>
          {[
            {
              num: '01', color: '#818cf8', bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.2)',
              title: 'Remote Worker Nodes',
              desc: 'Connect external daemons over Bearer token API keys. Containerized Minecraft servers powered by Docker Engine.',
            },
            {
              num: '02', color: 'var(--accent)', bg: 'var(--accent-dim)', border: 'var(--accent-border)',
              title: 'Modrinth Integration',
              desc: 'Search & deploy Modrinth modpacks seamlessly with environment variables passed straight to the container.',
            },
            {
              num: '03', color: '#c084fc', bg: 'rgba(192,132,252,0.08)', border: 'rgba(192,132,252,0.2)',
              title: 'Fine-Grained RBAC',
              desc: 'Owner, Server Admin, and Viewer roles with explicit EULA consent workflow before container creation.',
            },
          ].map(card => (
            <div key={card.num} className="cc-card" style={{ padding: '22px 20px' }}>
              <div style={{
                width: '32px', height: '32px', borderRadius: '6px',
                background: card.bg, border: `1px solid ${card.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.7rem', fontWeight: 800, color: card.color,
                marginBottom: '14px',
              }}>{card.num}</div>
              <h3 style={{ fontSize: '0.9375rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>{card.title}</h3>
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', lineHeight: 1.65, margin: 0 }}>{card.desc}</p>
            </div>
          ))}
        </div>
      </main>

      <footer style={{ borderTop: '1px solid var(--border)', padding: '20px 32px', textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
        CraftControl Server Manager · Built with Next.js, Prisma &amp; Dockerode
      </footer>
    </div>
  );
}
