import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import Link from 'next/link';

/**
 * Home page that redirects unauthenticated users to the login page and
 * provides a link to the upload page for signed-in users.
 */
export default function Home() {
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
    });
  }, []);

  // If no user, redirect to login.
  if (!user) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    return null;
  }

  return (
    <div style={{ padding: 24 }}>
      <h1>PlanVector</h1>
      <Link href="/app/upload">Upload a plan</Link>
    </div>
  );
}
