import fs from 'node:fs/promises';
import { FileBlob, PresentationFile } from '@oai/artifact-tool';
const source='D:/All Work/TM-X React/output/Problem_Statements_ALPL_Standard_16x9.pptx';
const deck=await PresentationFile.importPptx(await FileBlob.load(source));
const slide=deck.slides.items[0];
const preview=await deck.export({slide,format:'png',scale:1});
await fs.writeFile('D:/All Work/TM-X React/.codex-ppt-build/final-render-standard.png',new Uint8Array(await preview.arrayBuffer()));
console.log('Final PPTX rendered:',deck.slides.items.length,'slide');
