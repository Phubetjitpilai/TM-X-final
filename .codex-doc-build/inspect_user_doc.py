from docx import Document
from docx.oxml.ns import qn
from PIL import Image,ImageOps,ImageDraw
from pathlib import Path
from io import BytesIO
src=Path(r'C:\Users\User\Desktop\TM-X_Web_User_Manual_Template.docx')
out=Path(r'D:\All Work\TM-X React\.codex-doc-build\source_images')
out.mkdir(parents=True,exist_ok=True)
d=Document(src)
rows=[]
for i,p in enumerate(d.paragraphs):
  for j,blip in enumerate(p._p.xpath('.//a:blip')):
    rid=blip.get(qn('r:embed'))
    if not rid: continue
    part=d.part.related_parts[rid]
    im=Image.open(BytesIO(part.blob)).convert('RGB')
    dest=out/f'p{i:03d}_{j+1:02d}.png'; im.save(dest)
    rows.append((i,j+1,str(dest),im.size,p.text[:70]))
print('IMAGES',len(rows))
for row in rows: print(row)

thumbw,thumbh=250,180
cols=4; per=20
for sheet in range((len(rows)+per-1)//per):
  subset=rows[sheet*per:(sheet+1)*per]
  canvas=Image.new('RGB',(cols*280,((len(subset)+cols-1)//cols)*220),'white')
  draw=ImageDraw.Draw(canvas)
  for k,(pi,ji,fn,sz,pt) in enumerate(subset):
    im=Image.open(fn); im.thumbnail((thumbw,thumbh))
    x=(k%cols)*280+15; y=(k//cols)*220+10
    canvas.paste(im,(x,y)); draw.text((x,y+184),f'p{pi:03d} {sz[0]}x{sz[1]}',fill='black')
  canvas.save(out/f'contact_{sheet+1}.jpg',quality=90)
