<p align='center'>
<h1 align='center'>🗺️ map3d</h1>
<p align='center'>Generate a real world 3D map</p>
</p>

<p align='center'>
<a href="https://map.fleet.im/">Visit Website</a> · <a href="https://github.com/cartesiancs/map3d/issues">Report Bugs</a>
</p>

![img](./.github/screenshot.png)

## About The Project

This is a 3D building mapping service implemented with [React-Three-Fiber](https://github.com/pmndrs/react-three-fiber). It allows exporting as a GLB file, and all features are free to use. Based on this project, various functionalities such as **digital twin**, **drone surveying**, and **GPS markers** can be implemented.

The map files are based on OpenStreetMap data.

> [!IMPORTANT]
> 📢 <strong>This project cannot guarantee the accuracy of the data.</strong> Since it uses OpenStreetMap data, some height values may be missing or incorrectly recorded. To address this issue, an option will be added in the future to allow users to manually correct the data.

## Roadmap

- [x] Create 3D Buildings
- [x] Create Roads
- [x] Export GLB
- [ ] Building Texture
- [ ] Height Customization
- [ ] Material
- [ ] Heightmap

## Demo

https://github.com/user-attachments/assets/1b61c2f8-dcf9-40bb-9804-59f6a74594dc

## Contributors

Hyeong Jun Huh [(GitHub)](https://github.com/DipokalLab)

## License

MIT License

## Run and verify this fork

Use Node.js 24 (minimum 22.18), then `npm ci --ignore-scripts` and `npm run dev`.
Select **Select Box**, drag a small area, and use **Next Step** to fetch buildings
and enter the scene. **Export GLB → GLB Download** saves the model. Desktop car
mode uses WASD; it has no mobile touch controls.

- `npm run build`: TypeScript checks and production bundle
- `npm run lint`: JavaScript correctness and React hook checks (existing dependency warnings remain)
- `npm test`: offline road-loading regression test
- `npx playwright install chromium && npm run test:e2e`: browser smoke test with mocked map data and assets

The GitHub Checks workflow runs these on pushes and pull requests. Browser tests
use synthetic geometry; they do not verify live Overpass availability or map accuracy.
