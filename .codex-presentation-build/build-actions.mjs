import fs from 'node:fs/promises';
import path from 'node:path';
import { Presentation, PresentationFile } from '@oai/artifact-tool';
import { pathToFileURL } from 'node:url';

const workspaceDir = 'D:/All Work/TM-X React';
const SKILL_DIR = 'C:/Users/User/.codex/plugins/cache/openai-primary-runtime/presentations/26.904.11930/skills/presentations';
const TMP_DIR = path.join(workspaceDir, '.codex-presentation-build');
const FINAL_PPTX = path.join(workspaceDir, 'output', 'Auto_Sorter_Simple_ER_Diagram_Mockup_v2.pptx');
const RUNTIME_PYTHON = 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const { finalizePresentation } = await import(pathToFileURL(path.join(SKILL_DIR, 'container_tools/artifact_tool_utils.mjs')).href);
await fs.mkdir(TMP_DIR, {recursive: true});
await fs.mkdir(path.dirname(FINAL_PPTX), {recursive: true});
const logo = new Uint8Array(await fs.readFile(path.join(TMP_DIR, 'source', 'existing-logo.png')));
const p = Presentation.create({slideSize: {width: 1280, height: 720}});
const NAVY = '#002060';
const BLUE = '#1166A3';
const ORANGE = '#C9571B';
const BEIGE = '#F5E4DB';
const BODY = '#1F365C';
const MUTED = '#5D687B';
const RULE = '#C6D2DF';

function rect(slide, x, y, w, h, fill) {
  return slide.shapes.add({geometry:'rect', position:{left:x,top:y,width:w,height:h}, fill, line:{fill:'none',width:0}});
}
function text(slide, value, x,y,w,h, size, color, bold=false) {
  const s = slide.shapes.add({geometry:'textbox',position:{left:x,top:y,width:w,height:h},fill:'none',line:{fill:'none',width:0}});
  s.text = value;
  s.text.style = {typeface:'Aptos',fontSize:size,bold,color,autoFit:'none'};
  return s;
}
function base(actionTitle) {
  const slide = p.slides.add();
  slide.background.fill = '#FFFFFF';
  text(slide,'Actions',90,62,160,65,36,NAVY,true);
  rect(slide,250,64,760,55,BEIGE);
  text(slide,actionTitle,270,68,725,52,26,'#181818',true);
  slide.images.add({blob:logo,contentType:'image/png',alt:'Analog Devices and partner logos',fit:'contain',position:{left:1070,top:43,width:178,height:50}});
  rect(slide,0,699,1280,21,BLUE);
  return slide;
}
function steps(slide, items, closing, twoLineHeadings=false) {
  const xs = [90,470,850];
  items.forEach((item,i) => {
    const x=xs[i];
    text(slide,String(i+1).padStart(2,'0'),x,230,85,62,48,ORANGE,true);
    text(slide,item.heading,x,300,320,twoLineHeadings ? 82 : 55,28,NAVY,true);
    text(slide,item.body,x,twoLineHeadings ? 392 : 366,320,132,22,BODY,false);
  });
  rect(slide,445,236,1.5,290,RULE);
  rect(slide,825,236,1.5,290,RULE);
  rect(slide,90,564,1120,1.5,RULE);
  text(slide,closing,90,592,1120,60,26,NAVY,true);
}
function twoSteps(slide, items, closing) {
  const xs = [90, 470];
  items.forEach((item,i) => {
    const x=xs[i];
    text(slide,String(i+1).padStart(2,'0'),x,230,85,62,48,ORANGE,true);
    text(slide,item.heading,x,300,320,55,28,NAVY,true);
    text(slide,item.body,x,366,320,132,22,BODY,false);
  });
  rect(slide,445,236,1.5,290,RULE);
  rect(slide,90,564,1120,1.5,RULE);
  text(slide,closing,90,592,1120,60,26,NAVY,true);
}
function stepsWithImageSlots(slide, items) {
  const xs = [90, 470, 850];
  items.forEach((item,i) => {
    const x=xs[i];
    text(slide,String(i+1).padStart(2,'0'),x,174,85,62,48,ORANGE,true);
    text(slide,item.heading,x,243,320,65,27,NAVY,true);
    text(slide,item.body,x,316,320,103,21,BODY,false);
    slide.shapes.add({geometry:'rect',position:{left:x,top:445,width:320,height:178},fill:'#EFF5F9',line:{fill:'#A9C0D4',width:1.5}});
    rect(slide,x,445,320,6,BLUE);
    text(slide,'IMAGE 0'+(i+1),x+20,487,280,33,20,NAVY,true);
    text(slide,item.imageLabel,x+20,523,280,60,18,MUTED,false);
  });
  rect(slide,445,180,1.5,445,RULE);
  rect(slide,825,180,1.5,445,RULE);
}
function databaseDashboardMockup(slide) {
  text(slide,'01',90,174,85,62,48,ORANGE,true);
  text(slide,'Database',90,243,490,55,28,NAVY,true);
  text(slide,'Part details and measurements stay linked in one relational database.',90,316,490,96,21,BODY,false);
  text(slide,'02',670,174,85,62,48,ORANGE,true);
  text(slide,'Dashboard',670,243,490,55,28,NAVY,true);
  text(slide,'The dashboard summarizes data for all parts, refreshes daily, and is instantly accessible via a link.',670,316,490,96,21,BODY,false);
  rect(slide,625,180,1.5,445,RULE);

  rect(slide,297,527,68,3,ORANGE);
  text(slide,'1 : N',308,541,48,24,14,ORANGE,true);
  slide.shapes.add({geometry:'roundRect',position:{left:90,top:450,width:208,height:168},fill:'#EFF5F9',line:{fill:'#A9C0D4',width:1.5}});
  rect(slide,90,450,208,7,BLUE);
  text(slide,'PART DETAILS',108,471,175,32,19,NAVY,true);
  rect(slide,102,513,184,28,'#FBE7DB');
  text(slide,'ALPL Number',110,514,173,27,17,ORANGE,true);
  text(slide,'Package Size\nHandler  ·  Operator',108,551,175,55,16,BODY,false);
  slide.shapes.add({geometry:'roundRect',position:{left:364,top:450,width:208,height:168},fill:'#EFF5F9',line:{fill:'#A9C0D4',width:1.5}});
  rect(slide,364,450,208,7,BLUE);
  text(slide,'MEASUREMENTS',382,471,180,30,18,NAVY,true);
  rect(slide,376,513,184,28,'#FBE7DB');
  text(slide,'ALPL Number',384,514,173,27,17,ORANGE,true);
  text(slide,'Value X/Y  ·  OK/NG\nDate  ·  Result image',382,551,175,55,16,BODY,false);

  slide.shapes.add({geometry:'roundRect',position:{left:670,top:450,width:500,height:168},fill:'#EFF5F9',line:{fill:'#A9C0D4',width:1.5}});
  rect(slide,670,450,500,7,BLUE);
  text(slide,'DASHBOARD SCREENSHOT',694,475,445,35,20,NAVY,true);
  text(slide,'Daily results  ·  OK/NG summary  ·  Trends',694,521,445,48,18,MUTED,false);
}

let slide=base('Automate Measurement and Data Recording');
stepsWithImageSlots(slide,[
  {heading:'Web Application',body:'The operator enters part details and starts a run on the web.',imageLabel:'Part entry screen'},
  {heading:'TM-X Control',body:'The system directs TM-X to measure each part and receives the values.',imageLabel:'TM-X measuring the part'},
  {heading:'Result Decision\n& Auto Save',body:'The system decides OK/NG and automatically saves each result and its part details in the database.',imageLabel:'OK / NG result screen'},
]);
slide.speakerNotes.textFrame.setText('Action: operator enters part information on the web; TM-X supplies values and image; the system stores each result immediately.');

slide=base('Standardize and Centralize Data Access');
databaseDashboardMockup(slide);
slide.speakerNotes.textFrame.setText('Power BI is refreshed daily, so the dashboard is a daily summary rather than a live measurement feed. The source deck describes Good/Fail counts by package size and part number and a yield trend.');

const candidatePath = path.join(TMP_DIR,'actions-candidate.pptx');
await (await PresentationFile.exportPptx(p)).save(candidatePath);
for (let i=0;i<p.slides.items.length;i++) {
  const preview=await p.export({slide:p.slides.items[i],format:'png',scale:1});
  await fs.writeFile(path.join(TMP_DIR,`actions-preview-${i+1}.png`),new Uint8Array(await preview.arrayBuffer()));
}
const result=await finalizePresentation({
  workspaceDir,
  candidatePath,
  finalPath:FINAL_PPTX,
  pythonExecutable:RUNTIME_PYTHON,
  integrityValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(SKILL_DIR,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],
  explicitTotalSlideCount:2,
  requiredNativeTableOwnerSlides:[],
  requiredNativeChartOwnerSlides:[],
  fontPolicy:{basis:'design',families:['Aptos']},
  verifyArtifactToolImport:true,
  receiptPath:path.join(TMP_DIR,'actions-simple-er-v2.validation.json'),
});
console.log(JSON.stringify({finalPath:FINAL_PPTX,result},null,2));
