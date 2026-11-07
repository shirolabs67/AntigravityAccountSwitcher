[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $OutputDirectory,
  [Parameter(Mandatory)] [string[]] $AccountId,
  [Parameter(Mandatory)] [string[]] $InstanceId,
  [string] $ServerName = 'aas-router.local',
  [string] $OpenSsl
)

$ErrorActionPreference = 'Stop'
if ($ServerName -notmatch '^(?=.{1,253}$)[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$') {
  throw 'ServerName must be a DNS name used by the client TLS configuration.'
}
foreach ($id in @($AccountId) + @($InstanceId)) {
  if ($id -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$') { throw 'Invalid account or instance alias.' }
}
if (@($AccountId | Sort-Object -Unique).Count -ne $AccountId.Count -or
    @($InstanceId | Sort-Object -Unique).Count -ne $InstanceId.Count) { throw 'Duplicate account or instance alias.' }
if (-not $OpenSsl) {
  $found = Get-Command openssl.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $OpenSsl = $found.Source }
  else {
    $git = Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($git) { $OpenSsl = Join-Path (Split-Path (Split-Path $git.Source)) 'usr\bin\openssl.exe' }
  }
}
if (-not $OpenSsl -or -not (Test-Path -LiteralPath $OpenSsl -PathType Leaf)) {
  throw 'Pass the path to a trusted OpenSSL executable using -OpenSsl.'
}
$target = [IO.Path]::GetFullPath($OutputDirectory)
if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { throw 'Choose a new output directory under an administrator-only parent.' }
if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($target))) { throw 'Create a protected parent directory first.' }
$caDirectory = Join-Path $target 'ca-admin'
$caKey = Join-Path $caDirectory 'ca.key.pem'
$caCert = Join-Path $caDirectory 'ca.cert.pem'
[void][IO.Directory]::CreateDirectory($caDirectory)

function Invoke-AasOpenSsl {
  $output = & $OpenSsl @args
  if ($LASTEXITCODE -ne 0) { throw ('OpenSSL failed: ' + $args[0]) }
  return $output
}

Invoke-AasOpenSsl req -new -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 730 -subj '/CN=AAS deployment CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout $caKey -out $caCert
function New-AasLeaf {
  param([string] $Role, [string] $Alias, [string] $Usage, [string] $San)
  $roleDirectory = Join-Path $target $Alias
  $pki = Join-Path $roleDirectory 'pki'
  [void][IO.Directory]::CreateDirectory($pki)
  $key = Join-Path $pki ($Role + '.key.pem')
  $cert = Join-Path $pki ($Role + '.cert.pem')
  $csr = Join-Path $caDirectory ($Alias + '.csr')
  $ext = Join-Path $caDirectory ($Alias + '.ext')
  $options = @('basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature', "extendedKeyUsage=$Usage")
  if ($San) { $options += "subjectAltName=DNS:$San" }
  [IO.File]::WriteAllLines($ext, $options, [Text.UTF8Encoding]::new($false))
  $subject = if ($San) { $San } else { $Alias }
  Invoke-AasOpenSsl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj ('/CN=' + $subject) -keyout $key -out $csr
  Invoke-AasOpenSsl x509 -req -days 365 -CA $caCert -CAkey $caKey -CAcreateserial -in $csr -extfile $ext -out $cert
  Copy-Item -LiteralPath $caCert -Destination (Join-Path $pki 'ca.cert.pem')
  $result = Invoke-AasOpenSsl x509 -in $cert -noout -fingerprint -sha256
  if ($result -notmatch '=([A-Fa-f0-9:]+)$') { throw 'Could not read certificate fingerprint.' }
  return $Matches[1]
}

$pins = [ordered]@{
  serverName = $ServerName
  router = (New-AasLeaf 'router' 'router' 'serverAuth' $ServerName)
  workers = [ordered]@{}
  ingress = [ordered]@{}
}
foreach ($id in $AccountId) { $pins.workers[$id] = New-AasLeaf 'worker' ('worker-' + $id) 'clientAuth' }
foreach ($id in $InstanceId) { $pins.ingress[$id] = New-AasLeaf 'ingress' ('ingress-' + $id) 'clientAuth' }
[IO.File]::WriteAllText((Join-Path $target 'fingerprints.json'), ($pins | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Write-Output 'Created deployment certificate bundles. Keep ca-admin offline and distribute only the matching role bundle.'
