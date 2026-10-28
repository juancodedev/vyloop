import { redirect } from 'next/navigation';

/**
 * This page showed the same numbers as the summary. It is merged into
 * `/dashboard`, and the address stays so a bookmark lands somewhere useful.
 */
export default function LoyaltyPage() {
  redirect('/dashboard');
}
