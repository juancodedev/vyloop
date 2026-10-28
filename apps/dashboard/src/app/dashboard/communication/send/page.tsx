import { redirect } from 'next/navigation';

/**
 * Hidden while the platform does not use WhatsApp, which this page only
 * served. The previous version is in git history; it comes back with the
 * channel.
 */
export default function HiddenChannelPage() {
  redirect('/dashboard/communication/campaigns');
}
