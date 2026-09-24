const path = require('path');
const chalk = require('chalk');
const { maskSecrets } = require('../parser/hostRemap');

/** Temp workspace yolları build sonunda silindiği için proje köküne göre gösterilir. */
function rel(projectDir, p) {
  return path.relative(projectDir, p) || '.';
}

function formatPorts(ports) {
  if (!ports.length) return '-';
  return ports.map(p => `${p.hostIp ? `${p.hostIp}:` : ''}${p.host}→${p.container}${p.protocol !== 'tcp' ? `/${p.protocol}` : ''}`).join(', ');
}

function section(log, title) {
  log('');
  log(chalk.bold.underline(title));
}

/** Kaynak + compose parse sonucu. */
function printComposeSummary(result, { origin } = {}, log = console.log) {
  const { projectDir, webService, otherServices, report } = result;

  section(log, 'Compose');
  log(`  kaynak:        ${origin || '-'}`);
  log(`  dosya:         ${rel(projectDir, result.composePath)}`);

  if (webService) {
    log(`  web servisi:   ${chalk.cyan(webService.name)}`);
    log(`  build context: ${rel(projectDir, webService.build.context)}`);
    log(`  dockerfile:    ${webService.build.dockerfile ? rel(projectDir, webService.build.dockerfile) : '(inline)'}`);
    log(`  portlar:       ${formatPorts(webService.ports)}`);
    log(`  depends_on:    ${webService.dependsOn.join(', ') || '-'}`);
  }
  if (otherServices.length) {
    log(`  pakete dahil edilmeyen servisler: ${otherServices.map(s => s.name).join(', ')}`);
  }

  if (report.remaps.length) {
    log('');
    log(chalk.bold('  Servis adı → 127.0.0.1 yeniden yazımları:'));
    console.table(report.remaps.map(r => ({ servis: r.service, değişken: r.key, önce: r.before, sonra: r.after })));
  }

  if (report.missingVariables.length) {
    log('');
    log(chalk.yellow.bold(`  Tanımsız değişkenler (${report.missingVariables.length}):`));
    for (const m of report.missingVariables) {
      log(chalk.yellow(`    ${m.name}`) + chalk.gray(`  ← ${m.locations.join(', ')}`));
    }
  }
}

/** stackDetector sonucu. */
function printStackSummary(stack, log = console.log) {
  section(log, 'Uygulama');
  if (!stack.packageJson) {
    log(chalk.red('  Node.js projesi tespit edilemedi'));
    return;
  }
  log(`  paket:         ${stack.packageJson.name || '(isimsiz)'}${stack.packageJson.version ? `@${stack.packageJson.version}` : ''}`);

  const { entry } = stack;
  if (!entry) {
    log(`  entry:         ${chalk.red('tespit edilemedi')}`);
  } else if (entry.kind === 'ssr') {
    log(`  entry:         ${chalk.magenta(`SSR (${entry.framework})`)}  ${chalk.gray(`← ${entry.source}: ${entry.command}`)}`);
  } else {
    const flag = entry.exists ? '' : chalk.yellow(entry.producedByBuild ? ' (build çıktısı)' : ' (bulunamadı)');
    log(`  entry:         ${entry.file}${flag}  ${chalk.gray(`← ${entry.source}${entry.command ? `: ${entry.command}` : ''}`)}`);
  }

  log(`  port:          ${stack.port ? `${stack.port.value}  ${chalk.gray(`← ${stack.port.source}`)}` : chalk.red('tespit edilemedi')}`);
  if (stack.node) {
    log(`  node:          ${stack.node.major}  ${chalk.gray(`← ${stack.node.source}${stack.node.engines ? ` (engines: ${stack.node.engines})` : ''}`)}`);
  }
  const fw = [stack.framework.server, stack.framework.ssr && `${stack.framework.ssr} (SSR)`].filter(Boolean);
  log(`  framework:     ${fw.join(', ') || '-'}`);
}

const STATUS_LABEL = {
  ok: () => chalk.green('✔ uyumlu'),
  experimental: () => chalk.yellow('⚠ deneysel'),
  error: () => chalk.red('✖ hata'),
  external: () => chalk.cyan('↗ harici')
};

/** versionResolver sonucu. */
function printPreflight(versions, log = console.log) {
  section(log, `DB pre-flight (${versions.services.length} servis)`);
  if (!versions.services.length) {
    log('  DB servisi yok');
    return;
  }
  for (const s of versions.services) {
    const major = s.status === 'external' ? chalk.gray(`(${s.engine}, hedef makinede kurulu)`) : s.series !== null ? `v${s.series} ${chalk.gray(`(${s.seriesSource}${s.manifestEntry ? `, ${s.manifestEntry.version}` : ''})`)}` : chalk.gray('v?');
    log(`  ${STATUS_LABEL[s.status]()}  ${chalk.cyan(s.service.padEnd(12))} ${s.dbType.padEnd(8)} ${String(s.image).padEnd(28)} ${major}`);
  }
}

/** Tüm aşamalardan toplanan hata/uyarı/bilgi listesi. */
function printFindings({ errors, warnings, infos }, log = console.log) {
  if (infos.length) {
    section(log, 'Bilgi');
    infos.forEach(i => log(chalk.gray(`  • ${i}`)));
  }
  if (warnings.length) {
    section(log, `Uyarılar (${warnings.length})`);
    warnings.forEach(w => log(chalk.yellow(`  ⚠ ${w}`)));
  }
  if (errors.length) {
    section(log, `Hatalar (${errors.length})`);
    errors.forEach(e => log(chalk.red(`  ✖ ${e}`)));
  }
  log('');
}

/** `--json` çıktısı için şifreleri maskelenmiş kopya. */
function toPublicJson(result) {
  const maskEnv = env => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, maskSecrets(v)]));
  const maskService = s => s && { ...s, environment: maskEnv(s.environment), resolvedEnvironment: maskEnv(s.resolvedEnvironment) };
  return {
    ...result,
    webService: maskService(result.webService),
    buildServices: result.buildServices.map(maskService),
    dependencyServices: result.dependencyServices.map(maskService),
    otherServices: result.otherServices.map(maskService),
    raw: result.raw.map(maskService)
  };
}

module.exports = { printComposeSummary, printStackSummary, printPreflight, printFindings, toPublicJson };
