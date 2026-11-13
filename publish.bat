@echo off
rem ============================================================================
rem  publish.bat : build the Satellite Pass Planner and copy it into the local
rem  website folder, ready to commit and push with GitHub Desktop.
rem
rem  What it does, in order (it stops at the first problem and copies nothing):
rem    1. runs the planner's tests
rem    2. builds the planner for https://k1kfx.com/satellites/
rem    3. copies the build into  <website>\satellites\  ONLY
rem
rem  It never touches anything outside <website>\satellites\ (not hunt\, not the
rem  home page), and it leaves <website>\satellites\data\ alone: the Keplers and
rem  status files there are kept fresh by the website's own scheduled job.
rem  It does not commit or push. You do that in GitHub Desktop.
rem ============================================================================
setlocal
set "PLANNER=%~dp0"
set "SITE=C:\Users\Jeremy Smith\Documents\GitHub\k1kfx.com"
if not "%~1"=="" set "SITE=%~1"

cd /d "%PLANNER%" || goto :fail

if not exist "%SITE%\CNAME" (
  echo.
  echo STOPPED: "%SITE%" does not look like the website folder ^(no CNAME file^).
  goto :fail
)
if not exist "%SITE%\satellites\data\elements.json" (
  echo.
  echo STOPPED: "%SITE%\satellites\data\elements.json" is missing.
  echo In GitHub Desktop, open k1kfx.com and click "Pull origin", then try again.
  goto :fail
)

if not exist "node_modules\" (
  echo === First run: installing the build tools ^(a few minutes^) ===
  call npm ci || goto :fail
)

echo.
echo === Step 1 of 3: running the tests ===
call npm test || goto :fail

echo.
echo === Step 2 of 3: building for /satellites/ ===
call npm run build:satellites || goto :fail
if not exist "dist\index.html" goto :fail
if not exist "dist\version.json" goto :fail

echo.
echo === Step 3 of 3: copying into "%SITE%\satellites" ===
rem /MIR makes the folder match the build (old files are removed); /XD data skips the data folder on both sides.
robocopy "dist" "%SITE%\satellites" /MIR /XD data /NFL /NDL /NJH /NP
if errorlevel 8 goto :fail

echo.
echo ============================================================================
echo  DONE. The new planner is in the website folder, not yet published.
echo  Now, in GitHub Desktop:
echo    1. Open the k1kfx.com repository and click "Pull origin" if it is offered.
echo    2. Check that every changed file starts with  satellites/
echo    3. Type a summary, click "Commit to main", then "Push origin".
echo ============================================================================
pause
exit /b 0

:fail
echo.
echo ============================================================================
echo  NOT PUBLISHED. Something above failed; the website folder was not updated
echo  by this run. Nothing needs undoing. Scroll up to see the first error.
echo ============================================================================
pause
exit /b 1
