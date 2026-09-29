import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';
const source = 'D:/All Work/TM-X React/output/Auto_Sorter_Two_Actions.pptx';
const out = 'D:/All Work/TM-X React/.codex-presentation-build/source';
const pres = await PresentationFile.importPptx(await FileBlob.load(source));
console.log('slides',pres.slides.items.length);
for (const n of [1,2]) {
  const png = await pres.export({ slide: pres.slides.items[n-1], format: 'png', scale: 1 });
  await fs.writeFile(`${out}/source-slide-${n}.png`, new Uint8Array(await png.arrayBuffer()));
  console.log('rendered',n);
}
