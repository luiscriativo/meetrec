; Trecho extra do instalador NSIS (electron-builder copia para <app>/build/installer.nsh).
;
; Ao desinstalar, apaga o que o Electron deixa no perfil do usuário para as notificações do
; Windows e que o desinstalador padrão não conhece:
;   - o atalho no Menu Iniciar do usuário (%AppData%\...\Start Menu\Programs\<nome>.lnk), que o
;     app grava com ícone (src/main/win-shortcut.js) e o Electron criaria sem ícone;
;   - a(s) chave(s) HKCU\Software\Classes\CLSID\{...} do "Electron Notification Activator" cujo
;     LocalServer32 aponta para o executável deste app.
; Numa atualização (instalador rodando por cima) nada é apagado: o app regrava o atalho ao abrir.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}
    Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\${PRODUCT_NAME}.lnk"
    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}

    StrCpy $R0 0
    ${Do}
      EnumRegKey $R1 HKCU "Software\Classes\CLSID" $R0
      ${If} $R1 == ""
        ${ExitDo}
      ${EndIf}
      ReadRegStr $R2 HKCU "Software\Classes\CLSID\$R1\LocalServer32" ""
      ${If} $R2 == "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${OrIf} $R2 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
        DeleteRegKey HKCU "Software\Classes\CLSID\$R1"
        ; a lista encolheu: o mesmo índice já aponta para a próxima chave
      ${Else}
        IntOp $R0 $R0 + 1
      ${EndIf}
    ${Loop}
  ${endif}
!macroend
