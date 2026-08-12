import './globals.css';
import type { Metadata } from 'next';
import { AuthProvider } from '@/context/AuthContext';
import { UIPrefsProvider } from '@/context/UIPrefsContext';
import { ToastProvider } from '@/context/ToastContext';
import { ConfirmProvider } from '@/context/ConfirmContext';

export const metadata: Metadata = {
  title: 'CraftControl - Split Architecture Minecraft Server Manager',
  description: 'Control Plane Web Panel for managing remote Minecraft nodes and Modrinth modpacks',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Colours come from the design tokens in globals.css — utility classes here would
          out-specify the `body` rule and desync the app background from the token. */}
      <body>
        <AuthProvider>
          <UIPrefsProvider>
            <ToastProvider>
              <ConfirmProvider>{children}</ConfirmProvider>
            </ToastProvider>
          </UIPrefsProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
