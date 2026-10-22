import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

// ALLOW_PRIVATE=1 のときだけ localhost / LAN / クラウドのメタデータ (169.254.169.254) 等への接続を許可する。
// 公開しているプロキシから内部ネットワークを覗かれないようにするため、既定では拒否。
export const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';

const blockList = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blockList.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blockList.addSubnet(addr, prefix, 'ipv6');
}

export function isPrivateIp(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const family = net.isIP(ip);
  if (!family) return false;
  return blockList.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

export class BlockedError extends Error {}

/** DNS 解決結果まで確認する lookup (DNS リバインディング対策も兼ねる) */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!ALLOW_PRIVATE) addrs = addrs.filter((a) => !isPrivateIp(a.address));
    if (!addrs.length) return callback(new BlockedError(`ブロック: ${hostname} はプライベートアドレスです`));
    if (options.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  });
}

/** IP 直書きのホストは lookup を通らないので事前にチェックする */
export function assertHostAllowed(hostname) {
  if (ALLOW_PRIVATE) return;
  const h = hostname.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || isPrivateIp(h)) {
    throw new BlockedError(`ブロック: ${hostname} への接続は許可されていません (ALLOW_PRIVATE=1 で許可)`);
  }
}

export const agent = new Agent({
  connect: { lookup: safeLookup, timeout: 15_000 },
  headersTimeout: 60_000,
  bodyTimeout: 120_000,
});
