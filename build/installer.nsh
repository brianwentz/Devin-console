; Runs in .onInit AFTER initMultiUser (installer.nsi: initMultiUser at line 77,
; customInit at line 80), so $INSTDIR is already seeded from the registry
; InstallLocation of the pre-rename install (same nsis.guid) or holds the
; /D= override. Redirect only the old *default-named* folders to the new
; default (${APP_FILENAME} is the dir name initMultiUser would seed); a
; custom folder is left alone.
!macro customInit
  ${If} $INSTDIR != ""
    StrCpy $R0 $INSTDIR 17 -17
    ${If} $R0 == "\Devin Workspaces"
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${Else}
      StrCpy $R0 $INSTDIR 23 -23
      ${If} $R0 == "\Devin Workspaces Smoke"
      ${OrIf} $R0 == "\devin-workspaces-smoke"
        StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend
