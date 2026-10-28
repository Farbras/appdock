from pathlib import Path
from PIL import Image, ImageDraw
out=Path(__file__).resolve().parent.parent/'src-tauri'/'icons'
out.mkdir(parents=True,exist_ok=True)
im=Image.new('RGBA',(1024,1024),(0,0,0,0))
d=ImageDraw.Draw(im)
d.rounded_rectangle((20,20,1004,1004),radius=225,fill='#252739')
for rect,color in [((222,213,467,479),'#a5a6ff'),((528,213,773,479),'#777bf5'),((222,540,467,806),'#8b8eff'),((528,540,773,806),'#5e65d5')]:
    d.rounded_rectangle(rect,radius=57,fill=color)
im=im.resize((256,256),Image.Resampling.LANCZOS)
im.save(out/'icon.png')
im.save(out/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print(out)
