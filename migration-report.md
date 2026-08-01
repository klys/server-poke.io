# Essentials Migration Report

Generated: 2026-08-01T22:25:03.950Z

- **BLOCKER**: 0
- **HIGH**: 0
- **MEDIUM**: 74
- **LOW**: 0

## [MEDIUM] unsupported-script-command — Pueblo semilla (map-essentials-013)
- Event: Pokémon ball - Avanzado (id 46), page 2
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Pueblo semilla (map-essentials-013)
- Event: Pokémon ball - Avanzado (id 46), page 2
- Original: `Kernel.pbAddPokemon(p)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Pueblo semilla (map-essentials-013)
- Event: EV049 (id 49), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Pueblo semilla (map-essentials-013)
- Event: EV062 (id 62), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Pueblo semilla (map-essentials-013)
- Event: EV084 (id 84), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Claro oculto (map-essentials-035)
- Event: Pokémon ball - Avanzado (id 1), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Casa 3 (map-essentials-040)
- Event: Evalúa Características (id 2), page 0
- Original: `p=pbGetPokemon(1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Casa 3 (map-essentials-040)
- Event: Evalúa Características (id 2), page 0
- Original: `p=pbGetPokemon(1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Casa 3 (map-essentials-040)
- Event: Evalúa Características (id 2), page 0
- Original: `best=pbGet(2)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Casa 3 (map-essentials-040)
- Event: Evalúa Características (id 2), page 0
- Original: `best=pbGet(2)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Casa 3 (map-essentials-040)
- Event: Evalúa Características (id 2), page 0
- Original: `val=pbGet(3)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Casa 3 (map-essentials-040)
- Event: Juez Cinta Esfuerzo (id 5), page 0
- Original: `p=$Trainer.pokemonParty[0]`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Casa 3 (map-essentials-040)
- Event: Juez Cinta Esfuerzo (id 5), page 0
- Original: `poke=$Trainer.pokemonParty[0]`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Claro oculto (map-essentials-045)
- Event: Pokémon ball - Avanzado (id 1), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Ciudad Fortuna (map-essentials-047)
- Event: EV114 (id 114), page 2
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Centro Comercial Azotea (map-essentials-059)
- Event: Pokémon ball - Avanzado (id 6), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Villa Caocao (map-essentials-061)
- Event: Criador (id 1), page 0
- Original: `$PokemonGlobal.daycareEgg=0`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Villa Caocao (map-essentials-061)
- Event: Criador (id 1), page 0
- Original: `pbDayCareGetDeposited(-1,3,-1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Villa Caocao (map-essentials-061)
- Event: Criador (id 1), page 0
- Original: `pbDayCareGetDeposited(0,3,-1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Villa Caocao (map-essentials-061)
- Event: Dr Footstep (id 65), page 0
- Original: `poke=pbGetPokemon(1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Villa Caocao (map-essentials-061)
- Event: Dr Footstep (id 65), page 0
- Original: `p=pbGetPokemon(1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Villa Caocao (map-essentials-061)
- Event: Dr Footstep (id 65), page 0
- Original: `poke=pbGetPokemon(1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Guardería Pokémon (map-essentials-062)
- Event: Criadora (id 3), page 0
- Original: `pbDayCareDeposit(pbGet(1))`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Guardería Pokémon (map-essentials-062)
- Event: Criadora (id 3), page 0
- Original: `pbDayCareChoose(`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Guardería Pokémon (map-essentials-062)
- Event: Criadora (id 3), page 0
- Original: `pbDayCareGetDeposited(pbGet(1),3,4)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Guardería Pokémon (map-essentials-062)
- Event: Criadora (id 3), page 0
- Original: `pbDayCareWithdraw(pbGet(1))`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Guardería Pokémon (map-essentials-062)
- Event: Daisy (id 5), page 0
- Original: `poke=pbGetPokemon(1)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Pueblo Persea (map-essentials-064)
- Event: Trainer(5) (id 38), page 2
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Pueblo Persea (map-essentials-064)
- Event: EV029 (id 29), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Pueblo Noble (map-essentials-091)
- Event: Pokémon ball - Avanzado (id 45), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Claro oculto (map-essentials-099)
- Event: Pokémon ball - Avanzado (id 22), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Pueblo Annona (map-essentials-111)
- Event: Pokémon ball - Avanzado (id 76), page 1
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Pueblo Annona (map-essentials-111)
- Event: EV078 (id 78), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Bosque Perdido (map-essentials-118)
- Event: EV040 (id 40), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Bosque Perdido (map-essentials-118)
- Event: EV041 (id 41), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — casa embrujada (map-essentials-119)
- Event: EV006 (id 6), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — casa embrujada (map-essentials-119)
- Event: EV009 (id 9), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Ruta 14 (map-essentials-120)
- Event: samane (id 31), page 1
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Gymhielo (map-essentials-131)
- Event: NPC (id 10), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Claro Oculto (map-essentials-132)
- Event: NPC (id 1), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Pico Nevado (map-essentials-133)
- Event: Pokémon ball - Avanzado (id 25), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Pico Nevado (map-essentials-133)
- Event: EV047 (id 47), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Pueblo Floralis (map-essentials-137)
- Event: EV027 (id 27), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Pueblo Floralis (map-essentials-137)
- Event: EV040 (id 40), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Centro Pokémon (map-essentials-141)
- Event: sunker (id 10), page 1
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Centro Pokémon (map-essentials-141)
- Event: EV011 (id 11), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Archipiélago Paraíso (map-essentials-143)
- Event: Puerta (id 19), page 0
- Original: `Kernel.pbCancelVehicles`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Archipiélago Paraíso (map-essentials-147)
- Event: Pokémon ball - Avanzado (id 26), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Ciudad Hundida (map-essentials-149)
- Event: EV037 (id 37), page 0
- Original: `egg=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Ruinas misteriosas (map-essentials-153)
- Event: EV015 (id 15), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Ruta 18 (map-essentials-154)
- Event: EV052 (id 52), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Meseta Cielo (map-essentials-156)
- Event: EV017 (id 17), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — ??? (map-essentials-158)
- Event: EV036 (id 36), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — ??? (map-essentials-158)
- Event: EV069 (id 69), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Base Revolution (map-essentials-162)
- Event: EV021 (id 21), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Cima Cielo (map-essentials-167)
- Event: david(2) (id 18), page 1
- Original: `$scene = Scene_Credits.new`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Árbol Sagrado (map-essentials-168)
- Event: EV013 (id 13), page 1
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Árbol Sagrado (map-essentials-168)
- Event: EV026 (id 26), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Árbol Sagrado (map-essentials-168)
- Event: EV034 (id 34), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Hall de la Fama (map-essentials-176)
- Event: Escena Hall de la Fama (id 1), page 0
- Original: `for i in $Trainer.pokemonParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Hall de la Fama (map-essentials-176)
- Event: Escena Hall de la Fama (id 1), page 0
- Original: `pbHallOfFameEntry`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Entrada Zona Safari (map-essentials-178)
- Event: Counter(4) (id 2), page 0
- Original: `pbSafariState.pbStart(30)`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Entrada Zona Safari (map-essentials-178)
- Event: Counter(4) (id 2), page 1
- Original: `pbSafariState.pbEnd`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Entrada Zona Safari (map-essentials-178)
- Event: EV003 (id 3), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Zona Safari (map-essentials-180)
- Event: EV003 (id 3), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Zona Selva (map-essentials-181)
- Event: Pokémon ball - Avanzado (id 10), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Cueva Ancestral (map-essentials-196)
- Event: NPC (id 2), page 0
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Cueva desconocida (map-essentials-199)
- Event: diyare (id 38), page 1
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Cueva desconocida (map-essentials-199)
- Event: EV039 (id 39), page 0
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — MAP208 (map-essentials-208)
- Event: Pokémon ball - Avanzado (id 9), page 1
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] unsupported-script-command — Pueblo Magi (map-essentials-277)
- Event: niña2 (id 77), page 2
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters

## [MEDIUM] parallel-page-writes-state — Pueblo Magi (map-essentials-277)
- Event: EV073 (id 73), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] parallel-page-writes-state — Pueblo Magi (map-essentials-277)
- Event: EV080 (id 80), page 1
- Original: `Parallel-process page containing Control Switches/Variables/Self Switch`
- Current: Parallel pages are not executed online; its writes never happen
- Expected: Background loop applying the writes while the page is active
- Fix: Review the event; port the logic to an autorun/touch handler if progression depends on it

## [MEDIUM] unsupported-script-command — Pueblo Melico (map-essentials-283)
- Event: Michael (id 100), page 1
- Original: `p=$Trainer.lastParty`
- Current: Skipped (no-op) and logged at runtime
- Expected: Command effect applied like the original engine
- Fix: Add a handler to EventRuntime.applyScript or mark ignorable in essentialsScriptAdapters
