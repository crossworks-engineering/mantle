import type { Metadata } from 'next';
import './globals.css';
import { fontSans } from '@/lib/fonts';
import { ThemeProvider } from '@/components/theme-provider';

export const metadata: Metadata = {
  title: 'Mantle',
  description: 'Your tree of everything.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className={`${fontSans.variable} h-full font-sans antialiased`}>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
