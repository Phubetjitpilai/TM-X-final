import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const workspaceDir = 'D:/All Work/TM-X React';
const buildDir = path.join(workspaceDir, '.codex-ppt-build');
const outDir = path.join(workspaceDir, 'output');
const finalPath = path.join(outDir, 'Problem_Statements_ALPL_Standard_16x9.pptx');
const sourcePath = 'C:/Users/User/AppData/Local/Temp/codex-clipboard-b9e5f3cc-1e96-4eba-94fb-7f0cb3c57ab1.png';
const skillDir = 'C:/Users/User/.codex/plugins/cache/openai-primary-runtime/presentations/26.904.11930/skills/presentations';
const pythonExecutable = 'C:/Users/User/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const { finalizePresentation } = await import(pathToFileURL(path.join(skillDir, 'container_tools/artifact_tool_utils.mjs')).href);
await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(outDir, { recursive: true });

const SX=1280/1670, SY=720/942, SF=(SX+SY)/2;
const ppt = Presentation.create({slideSize:{width:1280,height:720}});
const slide = ppt.slides.add();
slide.background.fill = '#FFFFFF';
function scalePosition(p){return {...p,left:p.left*SX,top:p.top*SY,width:p.width*SX,height:p.height*SY}}
function addShape(cfg){return slide.shapes.add({...cfg,position:scalePosition(cfg.position),...(typeof cfg.borderRadius==='number'?{borderRadius:cfg.borderRadius*SF}:{}),...(cfg.line?{line:{...cfg.line,width:(cfg.line.width??0)*SF}}:{})})}
function addImage(cfg){return slide.images.add({...cfg,position:scalePosition(cfg.position)})}
const C={navy:'#092B6C',body:'#20437D',green:'#0B6B31',muted:'#5F7284',blue:'#075A9B',lightBlue:'#EFF7FD',circle:'#D6EDFB',red:'#B90000',pink:'#FDE6E7',pale:'#FAF8F6',grid:'#C9CDD1'};
const noLine={fill:'none',width:0};
function rect(x,y,w,h,fill='none',line='none',lw=0,r=0,name=''){
  return addShape({geometry:r?'roundRect':'rect',name,position:{left:x,top:y,width:w,height:h},fill,line:{style:'solid',fill:line,width:lw},...(r?{borderRadius:r}:{})});
}
function text(t,x,y,w,h,size=20,color=C.navy,bold=false,align='left',valign='middle',name=''){
  const s=addShape({geometry:'textbox',name,position:{left:x,top:y,width:w,height:h},fill:'none',line:noLine});
  s.text=t; s.text.style={typeface:'Arial',fontSize:size*SF,bold,color,alignment:align,verticalAlignment:valign,autoFit:'shrinkText',wrap:'square',insets:{top:0,right:0,bottom:0,left:0}}; return s;
}
function line(x1,y1,x2,y2,color='#C9CDD1',lw=1){return addShape({geometry:'line',position:{left:Math.min(x1,x2),top:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1),horizontalFlip:(x2<x1)!==(y2<y1)},fill:'none',line:{style:'solid',fill:color,width:lw}})}
function circle(x,y,d,fill){return addShape({geometry:'ellipse',position:{left:x,top:y,width:d,height:d},fill,line:noLine})}
async function cropImage(box,pos,alt){const blob=await sharp(sourcePath).extract(box).png().toBuffer();addImage({blob,contentType:'image/png',position:pos,fit:'contain',alt});}

// Header
text('Problem Statements',72,52,700,74,62,C.navy,true,'left','middle','Slide title');
text('Data Management & Reliability',72,139,900,52,40,C.green,true,'left','middle','Section heading');
text('Current ALPL data collection using Excel is manual, unstandardized, and prone to human error.',72,188,1455,38,27,C.muted,false);
await cropImage({left:1388,top:44,width:234,height:69},{left:1388,top:44,width:234,height:69},'Analog Devices and partner logos');

// Five problem rows. The icon images are crops of the supplied reference.
const rows=[
  {y:244,h:102,icon:{left:82,top:253,width:79,height:80},heading:'Records in separate Excel sheets',body:'Split by part size (e.g. HT9046, MX9046) with no standardized\nformat.'},
  {y:354,h:88,icon:{left:82,top:359,width:79,height:80},heading:'ALPL specifications are not centrally stored',body:'Need to search or ask operator at the PM Kit room.'},
  {y:452,h:87,icon:{left:82,top:456,width:79,height:80},heading:'Data access depends on operator',body:'No direct or immediate access.'},
  {y:548,h:87,icon:{left:82,top:552,width:79,height:80},heading:'No timestamp or operator identity',body:'When a result is questioned, root cause cannot be traced.'},
  {y:644,h:91,icon:{left:82,top:647,width:79,height:80},heading:'Manual recording causes frequent human error',body:'Result entries do not always match the measured values.'},
];
for(let i=0;i<rows.length;i++){
  const q=rows[i]; rect(63,q.y,744,q.h,'#FBF9F8','none',0,14,`Problem ${i+1} panel`);
  await cropImage(q.icon,{left:82,top:q.y+8,width:79,height:79},`Problem ${i+1} icon`);
  text(q.heading,196,q.y+7,600,37,23,C.navy,true);
  text(q.body,196,q.y+42,605,q.h-46,20,C.body,false,'left','top');
}

// Statistic callout.
rect(64,746,743,155,'#FCE8E9','none',0,18,'Error metric panel');
rect(99,814,18,30,C.red);rect(124,796,18,48,C.red);rect(149,778,18,66,C.red);
text('700 / 1,978 parts',211,757,570,62,55,C.red,true);
text('35.39%',211,819,160,43,37,C.red,true);
text('incorrect Result entries',380,823,410,39,31,C.red,false);
text('Based on HT9046 / HT9046MX Excel log review',211,867,554,26,18,C.muted,false);

// Right section 1: a rebuilt, editable excerpt of the Excel worksheet.
rect(834,240,797,365,C.lightBlue,'none',0,22,'Excel format panel');
circle(840,244,48,'#07508D'); text('1',840,246,48,43,31,'#FFFFFF',true,'center');
text('Unstandardized Excel Format',912,244,395,50,25,C.navy,true);
rect(1327,251,250,40,'#FAD6D8','none',0,6);text('Missing Column Headers',1343,256,224,30,18,C.red,true);
const gx=857,gy=303,gw=736;
rect(gx,gy,gw,218,'#FFFFFF','#D7DDE2',1);
// Column letters and row numbers.
const cols=[31,94,67,70,135,185,88,66];
let xx=gx; const letters=['','A','B','C','D','E','F','G'];
for(let c=0;c<cols.length;c++){rect(xx,gy,cols[c],27,'#F3F4F6','#D7DDE2',0.6);text(letters[c],xx,gy+1,cols[c],25,13,'#596575',false,'center');xx+=cols[c];}
let yy=gy+27;
const excelRows=[
  ['1','หมายเลข','X','Y','X3.00-Y3.05','','',''],
  ['2','2','3.090','3.097','FAIL','SAWN','',''],
  ['3','3','3.076','3.103','FAIL','SAWN','',''],
  ['4','4','3.054','3.068','FAIL','SAWN','',''],
  ['5','4','3.063','3.088','FAIL','SAWN','',''],
  ['6','6','3.090','3.117','FAIL','SAWN','',''],
];
for(let r=0;r<excelRows.length;r++){
  xx=gx; const h=r===0?32:29;
  for(let c=0;c<cols.length;c++){
    let fill=c===0?'#F5F6F7':'#FFFFFF',tc='#4C535A';
    if(r>0&&(c===2||c===3)){fill=(r===3||(r===4&&c===2))?'#CFF1D0':'#FCE0E1';tc=fill==='#CFF1D0'?'#138A26':'#D12323';}
    if(r===0&&(c===2||c===3)){fill='#FCE0E1';tc='#C51D1D';}
    rect(xx,yy,cols[c],h,fill,'#C9CDD1',0.7);text(excelRows[r][c],xx+2,yy+2,cols[c]-4,h-4,r===0?13:14,tc,false,'center');xx+=cols[c];
  }
  yy+=h;
}
rect(gx+40,gy+27,645,32,'none','#EC1717',2.6);
// Sheet tabs, each label is editable.
rect(gx,520,754,35,'#EDEFF1','#D7DDE2',0.7);text('‹   ›   ···',870,522,73,30,18,'#69737C');
const tabs=[['ALPL Dual AE04 3.5x3.75',943,214],['ALPL HT 6X6',1156,122],['HT 6X6 DEMPLE',1277,138],['ALPL HT DUAL 3.5X3.75',1415,190]];
for(const [label,x,w] of tabs)text(label,x,522,w,30,15,'#253647',false,'center');
rect(gx,520,754,35,'none','#EC1717',2.2);
rect(1170,563,444,37,'#FAD6D8','none',0,6);text('Inconsistent Sheet Naming (No Standardized Format)',1182,568,420,27,17,C.red,true);
line(1444,291,1444,324,C.red,2);addShape({geometry:'triangle',position:{left:1438,top:320,width:12,height:12,rotation:180},fill:C.red,line:noLine});
line(1142,555,1142,583,C.red,2);line(1142,583,1163,583,C.red,2);addShape({geometry:'triangle',position:{left:1159,top:577,width:13,height:13,rotation:90},fill:C.red,line:noLine});

// Right section 2: editable result grid and annotations.
rect(834,613,797,285,C.lightBlue,'none',0,23,'Result entries panel');
circle(841,615,51,'#07508D');text('2',841,618,51,44,31,'#FFFFFF',true,'center');
text('Inconsistent Result Entries',915,618,460,43,25,C.navy,true);
const rx=880,ry=675,rw=[117,117,197],rh=34;
const results=[
  ['4.050','4.036','GOOD'],['4.049','4.056','FAIL'],['4.044','4.049','GOOD'],
  ['4.133','4.160','FAIL'],['4.152','4.167','FAIL'],['4.057','4.060','FAIL']
];
for(let r=0;r<results.length;r++){
  let x=rx;for(let c=0;c<3;c++){
    const green=c<2&&(r===0&&c===0||r===1||r===2||r===5);
    const red=c<2&&!green;
    const fill=c===2?'#FFFFFF':green?'#CEF3D1':'#F9CBCD';
    rect(x,ry+r*rh,rw[c],rh,fill,'#252B2F',0.75);
    text(results[r][c],x+3,ry+r*rh+1,rw[c]-6,rh-2,21,c===2?'#111111':green?'#008029':'#BA0000',false,'center');x+=rw[c];
  }
}
rect(rx,ry+rh,431,rh,'none','#EA1010',2.5);rect(rx,ry+5*rh,431,rh,'none','#EA1010',2.5);
rect(1368,676,235,80,'#FAD5D7','none',0,7);text('Result recorded as FAIL\neven though the value\nis within range',1386,684,210,65,19,C.red,false,'left','top');
rect(1368,799,235,81,'#FAD5D7','none',0,7);text('Result recorded as FAIL\neven though the value\nis within range',1386,807,210,65,19,C.red,false,'left','top');
line(1367,713,1320,725,C.red,2);addShape({geometry:'triangle',position:{left:1312,top:719,width:13,height:13,rotation:270},fill:C.red,line:noLine});
line(1367,837,1320,854,C.red,2);addShape({geometry:'triangle',position:{left:1312,top:848,width:13,height:13,rotation:270},fill:C.red,line:noLine});

// Bottom bar from the supplied design.
rect(0,918,1670,24,'#0A64A8');
slide.speakerNotes.textFrame.setText('Recreated from the image supplied by the user. Values and wording follow that image; the logo and five icons are cropped from it.');

const candidatePath=path.join(buildDir,'candidate-standard.pptx');
await (await PresentationFile.exportPptx(ppt)).save(candidatePath);
const preview=await ppt.export({slide,format:'png',scale:1});
await fs.writeFile(path.join(buildDir,'preview-standard.png'),new Uint8Array(await preview.arrayBuffer()));
const result=await finalizePresentation({
  explicitTotalSlideCount:1,
  requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
  workspaceDir,candidatePath,finalPath,
  pythonExecutable,
  integrityValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','12192000,6858000','--validate-heading-fit'],
  fontPolicy:{basis:'design',families:['Arial']},
  verifyArtifactToolImport:true,
  receiptPath:path.join(buildDir,'validation-standard.json'),
});
console.log(JSON.stringify({finalPath,result},null,2));
