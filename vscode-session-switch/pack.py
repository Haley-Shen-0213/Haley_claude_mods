# 路徑： pack.py
# 把擴充打包成 .vsix（就是 zip 加上兩份描述檔），交給 code --install-extension 安裝；不需要 vsce 或 npm。
# 用法：python pack.py [輸出資料夾]　預設輸出到系統暫存資料夾，不在原始碼資料夾留下建置產物。
import json
import pathlib
import sys
import tempfile
import zipfile
from xml.sax.saxutils import escape

HERE = pathlib.Path(__file__).resolve().parent
FILES = ["package.json", "extension.js", "README.md"]

CONTENT_TYPES = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
"""


def manifest(pkg):
    kinds = ",".join(pkg.get("extensionKind") or ["workspace"])
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(pkg['name'])}" Version="{escape(pkg['version'])}" Publisher="{escape(pkg['publisher'])}" />
    <DisplayName>{escape(pkg.get('displayName', pkg['name']))}</DisplayName>
    <Description xml:space="preserve">{escape(pkg.get('description', ''))}</Description>
    <Categories>{escape(','.join(pkg.get('categories') or ['Other']))}</Categories>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{escape(kinds)}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"""


def main():
    pkg = json.loads((HERE / "package.json").read_text(encoding="utf-8"))
    out_dir = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(tempfile.gettempdir())
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{pkg['publisher']}.{pkg['name']}-{pkg['version']}.vsix"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("extension.vsixmanifest", manifest(pkg))
        for name in FILES:
            src = HERE / name
            if src.exists():
                z.write(src, f"extension/{name}")
    print(out)


if __name__ == "__main__":
    main()
