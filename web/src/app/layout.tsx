import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GTIDS Agreement Portal',
  description:
    'Gramtarang Inclusive Development Services — online agreement management and digital signing',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
