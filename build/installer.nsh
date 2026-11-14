; Extra shortcuts for the test build: the same program started with --test,
; which turns on the error log.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\HEoBS Test.lnk" "$INSTDIR\HEoBS.exe" "--test"
  CreateShortCut "$DESKTOP\HEoBS Test.lnk" "$INSTDIR\HEoBS.exe" "--test"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\HEoBS Test.lnk"
  Delete "$DESKTOP\HEoBS Test.lnk"
!macroend
