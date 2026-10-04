# Genera los recursos gráficos que exige la ficha de Google Play.
#
# Por qué PowerShell y no Node: hace falta escribir PNG de 32 bits CON canal alfa
# (para el icono) y de 24 bits SIN alfa (para el gráfico de función), y
# componer texto sobre una imagen. System.Drawing lo hace de forma nativa y sin
# dependencias. El PNG que genera a mano scripts/gen-icons.js es RGB sin alfa,
# y Play lo rechaza.
#
# Requisitos de Play que se respetan aquí:
#   - Icono de la app : 512x512, PNG de 32 bits con alfa, <= 1 MB.
#   - Gráfico de función: 1024x500, PNG de 24 bits SIN alfa, <= 15 MB.
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts/gen-play-assets.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$raiz    = Split-Path -Parent $PSScriptRoot
$origen  = Join-Path $raiz 'mobile\assets\icon.png'
$destino = Join-Path $raiz 'play-store'

if (-not (Test-Path -LiteralPath $origen)) { throw "No encuentro el icono de origen: $origen" }
New-Item -ItemType Directory -Path $destino -Force | Out-Null

$AZUL   = [System.Drawing.Color]::FromArgb(6, 61, 168)    # #063DA8
$ACENTO = [System.Drawing.Color]::FromArgb(0, 174, 234)   # #00AEEA

function Alto-Calidad {
    param([System.Drawing.Graphics]$g)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
}

# ---------------------------------------------------------------- icono 512
# Se deriva del icono REAL de la app (1024x1024) para que la ficha de Play
# muestre exactamente la misma imagen que el usuario ve instalado.
$src = [System.Drawing.Image]::FromFile($origen)
$icono = New-Object System.Drawing.Bitmap 512, 512, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($icono)
Alto-Calidad $g
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, 512, 512))
$g.Dispose()
$rutaIcono = Join-Path $destino 'icon-512.png'
$icono.Save($rutaIcono, [System.Drawing.Imaging.ImageFormat]::Png)
$icono.Dispose()
$src.Dispose()

# ------------------------------------------------- gráfico de función 1024x500
# 24 bits SIN alfa: Play rechaza el gráfico si tiene transparencia.
$fg = New-Object System.Drawing.Bitmap 1024, 500, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($fg)
Alto-Calidad $g

# Fondo azul de marca con un degradado diagonal suave hacia el acento.
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
    (New-Object System.Drawing.Point 0, 0),
    (New-Object System.Drawing.Point 1024, 500),
    $AZUL, $ACENTO)
$g.FillRectangle($brush, 0, 0, 1024, 500)
$brush.Dispose()

# Banda decorativa, contenida para no invadir los bordes que Play recorta.
$banda = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(38, 255, 255, 255))
$g.FillRectangle($banda, 0, 396, 1024, 6)
$banda.Dispose()

# Icono de la app a la izquierda.
$src2 = [System.Drawing.Image]::FromFile($origen)
$g.DrawImage($src2, (New-Object System.Drawing.Rectangle 84, 138, 224, 224))
$src2.Dispose()

# Texto de marca. Todo dentro del margen seguro central: Google recorta los
# bordes de este gráfico en distintas superficies y el logo no debe perderse.
$fuenteTitulo = New-Object System.Drawing.Font 'Segoe UI', 58, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$fuenteSub    = New-Object System.Drawing.Font 'Segoe UI', 30, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
$fuentePie    = New-Object System.Drawing.Font 'Segoe UI', 25, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)

$blanco = [System.Drawing.Brushes]::White
$claro  = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(214, 255, 255, 255))
$acento = New-Object System.Drawing.SolidBrush $ACENTO

$formato = [System.Drawing.StringFormat]::GenericTypographic.Clone()
$formato.Alignment = [System.Drawing.StringAlignment]::Near

$g.DrawString('OSTEOMUR Training', $fuenteTitulo, $blanco, (New-Object System.Drawing.PointF 348, 168), $formato)
$g.DrawString('Entrenamiento personal', $fuenteSub, $acento, (New-Object System.Drawing.PointF 352, 252), $formato)
$g.DrawString('Valoracion  ·  Reservas  ·  Progreso', $fuentePie, $claro, (New-Object System.Drawing.PointF 352, 302), $formato)

$g.Dispose()
$rutaFg = Join-Path $destino 'feature-graphic-1024x500.png'
$fg.Save($rutaFg, [System.Drawing.Imaging.ImageFormat]::Png)
$fg.Dispose()

$formato.Dispose(); $acento.Dispose(); $claro.Dispose()
$fuenteTitulo.Dispose(); $fuenteSub.Dispose(); $fuentePie.Dispose()

# --------------------------------------------------------------- verificacion
foreach ($r in @(
    @{ f = $rutaIcono; w = 512; h = 512; alfa = $true  },
    @{ f = $rutaFg;    w = 1024; h = 500; alfa = $false }
)) {
    $img = [System.Drawing.Image]::FromFile($r.f)
    $okDim = ($img.Width -eq $r.w -and $img.Height -eq $r.h)
    $okAlfa = if ($r.alfa) { $img.PixelFormat.ToString() -match 'Argb' } else { $img.PixelFormat.ToString() -notmatch 'Argb' }
    $kb = [math]::Round((Get-Item $r.f).Length / 1KB, 1)
    Write-Host ("  {0,-34} {1}x{2}  {3}  {4} KB  dims:{5} alfa:{6}" -f `
        (Split-Path -Leaf $r.f), $img.Width, $img.Height, $img.PixelFormat, $kb,
        $(if ($okDim) { 'OK' } else { 'FALLO' }),
        $(if ($okAlfa) { 'OK' } else { 'FALLO' }))
    $img.Dispose()
}

Write-Host ''
Write-Host 'Recursos de Play generados en play-store\:'
Write-Host '  icon-512.png               (ficha de la app)'
Write-Host '  feature-graphic-1024x500.png  (cabecera de la ficha)'
Write-Host ''
