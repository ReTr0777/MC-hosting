; Extra uninstall steps for the node app.
;
; The "start at sign-in" toggle calls app.setLoginItemSettings(), which writes a
; value into HKCU\...\Run named after the product. NSIS knows nothing about that
; value, so without this the uninstaller leaves a Run entry pointing at an
; executable it just deleted — Windows then fails it silently at every login.
;
; DeleteRegValue is a no-op when the value is absent, so this is safe whether or
; not the user ever turned auto-start on.

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MC Hosting Node"
!macroend
