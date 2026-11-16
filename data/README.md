# Data

All files are small tables of published figures, typed in by hand from the sources below and checked against them on 2026-11-16. They contain no personal data. Full citations are in [REFERENCES.md](../REFERENCES.md).

| File | Description | Source | Licence of the source | Date accessed |
|---|---|---|---|---|
| `recorded_frequency.csv` | Seven recorded values of system frequency and of the output of the frequency-controlling unit, 11:13:40.0 to 11:13:58.7 on 9 February 2025 | Wettasinghe (2026), Table 8, [doi:10.4038/engineer.v59i1.7740](https://doi.org/10.4038/engineer.v59i1.7740) | CC BY-ND 4.0 (figures quoted with attribution) | 2026-11-16 |
| `recorded_events.csv` | Disturbance-recorder times of the fault, the 49.5 Hz crossing, each load-shedding stage and the generator trips | PUCSL public hearing report (2026), Table 6.3, p. 14 | Public document of the regulator | 2026-11-16 |
| `ufls_stages.csv` | Load-shedding stages as operated: threshold, delay, megawatts shed; rooftop capacity on each stage's feeders | Wettasinghe (2026), Table 7; Ceylon Electricity Board committee report (2025), Tables 4.2 and 5.5 | CC BY-ND 4.0; public document of the utility | 2026-11-16 |
| `unit_inertia.csv` | Inertia constants and ratings of generating units, and the units known to be online | Ceylon Electricity Board committee report (2025), Table 6.1 and Annexure 2 | Public document of the utility | 2026-11-16 |
| `parameters.csv` | Every model input with its value, unit, source, table or page, and whether it is verified, derived or assumed | Mixed; see the `source` and `table_or_page` columns | As above | 2026-11-16 |

## Notes

- Time zero in `recorded_frequency.csv` and `recorded_events.csv` is 11:13:40.0, the first row of the journal's Table 8. The fault began 0.49 s earlier.
- The two instruments (the unit's data logger and the disturbance recorder) disagree by up to about 0.6 s at the same frequency. The model is fitted to the first and tested against the second.
- In `ufls_stages.csv` the last stage has no trigger printed in the journal table; the utility's committee report gives it as "below 49 Hz with a rate of fall beyond 0.85 Hz/s for 100 ms".
- `status` in `parameters.csv`: *verified* = read in the source; *derived* = arithmetic on verified values; *assumed* = a modelling choice, stated in the notebook.
