# QA Checklist

## Sprints restants (a valider)
1) Chat/IA — Verifier visuellement que CHAT_USER masque les icones et que CHAT_EDIT les conserve.
2) CockpitWeek — Verifier que tous les boutons d’action (voir / reproposer / sauvegarder / valider) apparaissent et fonctionnent selon les regles actuelles.

## Test manuel (Action 2)
1) Ouvrir http://localhost:5174
2) Refresh dur (Cmd+Shift+R ou Ctrl+Shift+R)
3) Dans le chat:
   - "Lundi diner : Crepes"
   - Attendu: icones masquees sur ce slot (voir/reproposer/sauvegarder)
4) Dans le chat:
   - "Remplacer quinoa par riz"
   - Attendu: icones visibles (CHAT_EDIT)

## Test manuel (Action 3)
1) Ouvrir http://localhost:5174
2) Ouvrir Cockpit Semaine (page semaines)
3) Verifier un slot avec recette Drive: bouton "Sauvegarder" absent, "Voir/Reproposer" visibles
4) Verifier un slot valide non-Drive: "Voir/Reproposer/Sauvegarder" visibles
5) Verifier un slot texte libre force: icones masquees
6) Cliquer "Valider" sur une proposition:
   - Attendu: bouton desactive + label "Validation en cours"
