import sharp from "sharp";
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 96}" fill="#09090b"/>
  <g transform="translate(256 270) scale(${pad ? 0.72 : 0.9}) translate(-256 -270)">
    <path d="M256 92 412 168v196L256 440 100 364V168z" fill="#3987e5"/>
    <path d="M256 92 412 168 256 244 100 168z" fill="#7fb2f0"/>
    <path d="M256 244v196L100 364V168z" fill="#2a6cc0"/>
    <path d="M178 130l156 76v62l-26 12v-60L152 144z" fill="#e8eef8" opacity=".9"/>
  </g></svg>`;
for (const [name, size, pad] of [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["maskable-512.png", 512, true], ["apple-touch-icon.png", 180, false]]) {
  await sharp(Buffer.from(svg(pad))).resize(size, size).png().toFile(`web/public/icons/${name}`);
}
console.log("icons ok");
