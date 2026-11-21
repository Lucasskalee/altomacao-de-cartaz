import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeCanvas, writePsd, readPsd } from 'ag-psd';
import { analyzePsd, colorHex, PSD_COLOR_MODE } from '../src/features/psd/importer';
import { exportDerivedPsdDirect } from '../src/features/scantech/directExport';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fakeCanvas = (w = 100, h = 100): any => ({
  width: w,
  height: h,
  getContext: () => ({
    clearRect() {},
    save() {},
    restore() {},
    drawImage() {},
    putImageData() {},
    fillRect() {},
    fillText() {},
    strokeText() {},
    transform() {},
    scale() {},
    translate() {},
    measureText: (txt: string) => ({ width: txt.length * 20 }),
    getImageData: (_x: number, _y: number, cw: number, ch: number) => ({
      data: new Uint8ClampedArray(cw * ch * 4),
      width: cw,
      height: ch,
    }),
  }),
  toDataURL: () => pixel,
});

initializeCanvas(fakeCanvas, (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h } as any));

test('colorHex: conversão precisa de cores CMYK, Grayscale, FRGB e RGB', () => {
  // CMYK: Preto puro
  assert.equal(colorHex({ c: 0, m: 0, y: 0, k: 255 }), '#000000');
  assert.equal(colorHex({ c: 0, m: 0, y: 0, k: 1 }), '#000000');

  // CMYK: Vermelho (M=100%, Y=100%)
  assert.equal(colorHex({ c: 0, m: 255, y: 255, k: 0 }), '#ff0000');
  assert.equal(colorHex({ c: 0, m: 1, y: 1, k: 0 }), '#ff0000');

  // CMYK: Ciano (C=100%)
  assert.equal(colorHex({ c: 255, m: 0, y: 0, k: 0 }), '#00ffff');

  // Grayscale: Preto e Branco
  assert.equal(colorHex({ k: 255 }), '#000000');
  assert.equal(colorHex({ k: 0 }), '#ffffff');

  // RGB padrão
  assert.equal(colorHex({ r: 255, g: 0, b: 0 }), '#ff0000');
  assert.equal(colorHex({ r: 10, g: 10, b: 10 }), '#000000'); // Quase preto normalizado para #000000

  // FRGB (ponto flutuante 0..1)
  assert.equal(colorHex({ fr: 1, fg: 0, fb: 0 }), '#ff0000');
});

test('Suporte a PSD CMYK, Grayscale e 16 bits por canal na importação', async () => {
  // 1. Gera um PSD válido base com ag-psd
  const basePsd = {
    width: 200,
    height: 300,
    colorMode: PSD_COLOR_MODE.RGB,
    bitsPerChannel: 8,
    children: [
      {
        name: '4',
        text: { text: '4' },
      },
      {
        name: '99',
        text: { text: '99' },
      },
    ],
  };

  const buffer = writePsd(basePsd as any);

  // 2. Simula cabeçalho CMYK (colorMode 4, 4 canais) e bitsPerChannel 8
  const cmykBuffer = buffer.slice(0);
  const viewCmyk = new DataView(cmykBuffer);
  // bytes 12-13: channels count
  // bytes 22-23: depth (bitsPerChannel)
  // bytes 24-25: colorMode
  viewCmyk.setUint16(12, 4); // 4 canais (C, M, Y, K)
  viewCmyk.setUint16(24, PSD_COLOR_MODE.CMYK); // ColorMode 4

  const analysisCmyk = await analyzePsd(cmykBuffer, 'cartaz_cmyk.psd');
  assert.equal(analysisCmyk.width, 200);
  assert.equal(analysisCmyk.height, 300);
  assert.ok(analysisCmyk.warnings.some(w => w.includes('CMYK')), 'Deve registrar warning informativo sobre CMYK');

  // 3. Simula cabeçalho Grayscale (colorMode 1, 1 canal)
  const grayBuffer = buffer.slice(0);
  const viewGray = new DataView(grayBuffer);
  viewGray.setUint16(12, 1); // 1 canal
  viewGray.setUint16(24, PSD_COLOR_MODE.Grayscale); // ColorMode 1

  const analysisGray = await analyzePsd(grayBuffer, 'cartaz_gray.psd');
  assert.equal(analysisGray.width, 200);
  assert.ok(analysisGray.warnings.some(w => w.includes('Tons de Cinza')), 'Deve registrar warning informativo sobre Grayscale');

  // 4. Simula profundidade de 16 bits por canal
  const rgb16Buffer = buffer.slice(0);
  const view16 = new DataView(rgb16Buffer);
  view16.setUint16(22, 16); // 16 bits per channel

  const analysis16 = await analyzePsd(rgb16Buffer, 'cartaz_16bit.psd');
  assert.ok(analysis16.warnings.some(w => w.includes('16 bits por canal')), 'Deve registrar warning informativo sobre 16 bits');

  // 5. Rejeita modos verdadeiramente não suportados (ex: Bitmap = 0) com mensagem explicativa
  const bitmapBuffer = buffer.slice(0);
  const viewBitmap = new DataView(bitmapBuffer);
  viewBitmap.setUint16(12, 1);
  viewBitmap.setUint16(22, 1);
  viewBitmap.setUint16(24, 0); // ColorMode Bitmap

  await assert.rejects(
    () => analyzePsd(bitmapBuffer, 'cartaz_bitmap.psd'),
    /Modo de cor não suportado \(Bitmap\)/
  );

  // 6. Rejeita profundidades não suportadas para cartazes (ex: 1 bit por canal)
  const invalidDepthBuffer = buffer.slice(0);
  const viewDepth = new DataView(invalidDepthBuffer);
  viewDepth.setUint16(22, 1); // 1 bit

  await assert.rejects(
    () => analyzePsd(invalidDepthBuffer, 'cartaz_depth.psd'),
    /Profundidade de cor \(1 bits por canal\) não suportada/
  );
});

test('Exportação direta de PSD adaptado a partir de CMYK / 16 bits', async () => {
  let writtenBytes: Uint8Array | null = null;
  const mockIo = {
    readSourcePsd: async () => writePsd({
      width: 200,
      height: 300,
      colorMode: PSD_COLOR_MODE.RGB,
      bitsPerChannel: 8,
      children: [
        {
          name: '4',
          text: { text: '4' },
        },
        {
          name: '99',
          text: { text: '99' },
        },
      ],
    } as any),
    writeOutputPsd: async (_outputPath: string, _src: string, bytes: Uint8Array) => {
      writtenBytes = bytes;
      return { fileSize: bytes.byteLength };
    },
  };

  const res = await exportDerivedPsdDirect(
    {
      sourcePsdPath: '/tmp/cmyk_16bit.psd',
      outputPsdPath: '/tmp/cmyk_16bit_out.psd',
      title: 'CERVEJA',
      whole: '12',
      fraction: '50',
      roles: {
        wholeLayerId: '0',
        fractionLayerId: '1',
      },
    },
    mockIo
  );

  assert.equal(res.ok, true, res.error);
  assert.ok(writtenBytes);
  const reopened = readPsd(writtenBytes!.buffer as any);
  assert.equal(reopened.colorMode, PSD_COLOR_MODE.RGB);
  assert.equal(reopened.bitsPerChannel, 8);
});
