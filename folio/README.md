# Folio Night Edition

A separate personal anime and manga companion inside this repository. The existing Nexus Reader root application is preserved.

This subdirectory contains the source package, reconstructed from `.folio-source/part-*.b64` during deployment. The Render Blueprint at the repository root launches Folio as a separate Node service.

OAuth login still requires a working callback implementation before configuring a production MAL redirect URL.
