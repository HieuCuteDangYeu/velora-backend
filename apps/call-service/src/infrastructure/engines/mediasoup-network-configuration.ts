import { isIP } from 'node:net';

type MediasoupNetworkConfigurationInput = {
  environment?: string;
  announcedIp?: string;
};

const isPrivateOrUnroutableIpv4 = (address: string) => {
  const [first, second] = address.split('.').map(Number);

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const isPrivateOrUnroutableIpv6 = (address: string) => {
  const normalized = address.toLowerCase();

  if (normalized === '::' || normalized === '::1') {
    return true;
  }

  if (normalized.startsWith('::ffff:')) {
    const mappedIpv4 = normalized.slice('::ffff:'.length);
    return isIP(mappedIpv4) === 4 && isPrivateOrUnroutableIpv4(mappedIpv4);
  }

  return (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('2001:db8:')
  );
};

export const isPublicIpv4 = (address: string) =>
  isIP(address) === 4 && !isPrivateOrUnroutableIpv4(address);

export const validateMediasoupNetworkConfiguration = ({
  environment,
  announcedIp,
}: MediasoupNetworkConfigurationInput) => {
  if (environment?.toLowerCase() !== 'production') {
    return;
  }

  const normalizedAnnouncedIp = announcedIp?.trim();
  if (!normalizedAnnouncedIp) {
    throw new Error(
      'MEDIASOUP_ANNOUNCED_IP must be configured with the public SFU address in production',
    );
  }

  const addressFamily = isIP(normalizedAnnouncedIp);
  if (!addressFamily) {
    throw new Error(
      'MEDIASOUP_ANNOUNCED_IP must be a valid IP address in production',
    );
  }

  const isUnroutable =
    addressFamily === 4
      ? isPrivateOrUnroutableIpv4(normalizedAnnouncedIp)
      : isPrivateOrUnroutableIpv6(normalizedAnnouncedIp);

  if (isUnroutable) {
    throw new Error(
      'MEDIASOUP_ANNOUNCED_IP must not be a private, loopback, link-local, or reserved address in production',
    );
  }
};

export const getAnnouncedIpAddressFamily = (announcedIp?: string) => {
  const addressFamily = announcedIp ? isIP(announcedIp.trim()) : 0;
  return addressFamily === 6 ? 'IPv6' : 'IPv4';
};
