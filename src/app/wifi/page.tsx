import type { Metadata } from 'next';
import OasisWifi from '@/components/oasis-wifi/OasisWifi';

export const metadata: Metadata = {
  title: 'OASIS WIFI',
  description: 'OASIS WIFI — see movement through WiFi. Live motion sensing from this computer’s own WiFi link, and CSI sensor nodes for presence and vital signs.',
};

export default function WifiPage() {
  return <OasisWifi />;
}
