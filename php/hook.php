<?php
// GitNow deploy hook.
// GitNow uploads this file for one deploy, calls it once over HTTPS with a secret token,
// and the file deletes itself. It only runs the commands written into it below; a
// request can't add or change commands. Generated from php/hook.php in gitnow-actions.

declare(strict_types=1);

const GITNOW_TOKEN_HASH = '__TOKEN_HASH__';
const GITNOW_CREATED_AT = __CREATED_AT__;
const GITNOW_COMMANDS = '__COMMANDS__';
const GITNOW_APP_ROOT = '__APP_ROOT__';
const GITNOW_PHP_CLI = '__PHP_CLI__';
const GITNOW_MAX_AGE = 900;

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');
header('X-Accel-Buffering: no');
header('X-Robots-Tag: noindex');

$token = (string) ($_SERVER['HTTP_X_GITNOW_TOKEN'] ?? '');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' || !hash_equals(GITNOW_TOKEN_HASH, hash('sha256', $token))) {
    http_response_code(404);
    exit;
}

// Single use: remove this file before running anything.
@unlink(__FILE__);

if (time() - GITNOW_CREATED_AT > GITNOW_MAX_AGE) {
    http_response_code(410);
    echo "[gitnow] This deploy hook has expired.\n[gitnow] result: failed\n";
    exit;
}

@set_time_limit(0);
ignore_user_abort(true);
while (ob_get_level() > 0) {
    ob_end_flush();
}
ob_implicit_flush(true);

function gitnow_out(string $text): void
{
    echo $text;
    flush();
}

/** Find the PHP command-line program. Under PHP-FPM, PHP_BINARY is not the CLI. */
function gitnow_php_cli(): string
{
    $configured = (string) base64_decode(GITNOW_PHP_CLI);
    if ($configured !== '') {
        return $configured;
    }
    $version = PHP_MAJOR_VERSION . '.' . PHP_MINOR_VERSION;
    $candidates = [];
    if (in_array(PHP_SAPI, ['cli', 'cli-server'], true) && PHP_BINARY !== '') {
        $candidates[] = PHP_BINARY;
    }
    if (PHP_BINARY !== '') {
        $dir = dirname(PHP_BINARY);
        $candidates[] = $dir . '/php' . $version;
        $candidates[] = $dir . '/php';
    }
    array_push($candidates, '/usr/bin/php' . $version, '/usr/local/bin/php' . $version, '/usr/local/bin/php', '/usr/bin/php');
    foreach (array_unique($candidates) as $candidate) {
        if (@is_file($candidate) && @is_executable($candidate)) {
            return $candidate;
        }
    }
    return 'php';
}

/** Run one command in the app folder, streaming its output. Returns the exit code. */
function gitnow_run(string $command, string $cwd, string $php): int
{
    if (preg_match('/^php(\s|$)/', $command) === 1) {
        $command = escapeshellarg($php) . substr($command, 3);
    }
    $process = proc_open($command . ' 2>&1', [0 => ['pipe', 'r'], 1 => ['pipe', 'w']], $pipes, $cwd);
    if (!is_resource($process)) {
        gitnow_out("[gitnow] Could not start the command.\n");
        return 127;
    }
    fclose($pipes[0]);
    $out = $pipes[1];

    if (DIRECTORY_SEPARATOR === '\\') {
        // Windows (local testing only): stream_select doesn't work on process pipes.
        while (!feof($out)) {
            $chunk = fread($out, 8192);
            if ($chunk === false) {
                break;
            }
            gitnow_out($chunk);
        }
        fclose($out);
        return proc_close($process);
    }

    stream_set_blocking($out, false);
    $quietSince = time();
    $exitCode = null;
    while (true) {
        $read = [$out];
        $write = null;
        $except = null;
        $ready = @stream_select($read, $write, $except, 5);
        if ($ready === false) {
            usleep(200000);
        } elseif ($ready > 0) {
            $chunk = fread($out, 8192);
            if ($chunk !== false && $chunk !== '') {
                gitnow_out($chunk);
                $quietSince = time();
            } elseif (feof($out)) {
                break;
            }
        } elseif (time() - $quietSince >= 25) {
            // Keeps proxies from closing a connection that looks idle.
            gitnow_out("[gitnow] still running...\n");
            $quietSince = time();
        }
        $status = proc_get_status($process);
        if (!$status['running']) {
            $exitCode = $status['exitcode'];
            while (($chunk = fread($out, 8192)) !== false && $chunk !== '') {
                gitnow_out($chunk);
            }
            break;
        }
    }
    fclose($out);
    $closed = proc_close($process);
    return $exitCode ?? $closed;
}

if (!function_exists('proc_open')) {
    gitnow_out("[gitnow] This server does not let PHP start commands (proc_open is disabled).\n[gitnow] result: failed\n");
    exit;
}

$root = realpath(__DIR__ . '/' . GITNOW_APP_ROOT) ?: __DIR__;
$php = gitnow_php_cli();
$commands = json_decode((string) base64_decode(GITNOW_COMMANDS), true);
$commands = is_array($commands) ? $commands : [];

gitnow_out("[gitnow] PHP: $php\n");
foreach ($commands as $command) {
    gitnow_out("[gitnow] \$ $command\n");
    $code = gitnow_run((string) $command, $root, $php);
    gitnow_out("\n[gitnow] exit code $code\n");
    if ($code !== 0) {
        gitnow_out("[gitnow] result: failed\n");
        exit;
    }
}
gitnow_out("[gitnow] result: ok\n");
