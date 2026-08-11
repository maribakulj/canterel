# Migration `openscienceDH` → `canterel`

1. préparer package/CLI/docs en conservant alias temporaire si nécessaire ;
2. renommer repo GitHub ;
3. vérifier redirects, badges, imports et publication ;
4. ajouter `canterel worker --locus ...` ;
5. introduire LEP SDK adapter ;
6. importer provenance existante vers Locus via outil dédié, sans la supprimer ;
7. garder mode standalone et tests de non-régression.
