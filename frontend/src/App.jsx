import { useEffect } from "react";
import { Loader } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { Leva } from "leva";
import { Experience } from "./components/Experience";
import { UI } from "./components/UI";

function App() {
  useEffect(() => {
    // Send a GET request to warm up the backend
    fetch("https://komai.onrender.com/")
      .then((response) => {
        if (!response.ok) {
          console.warn("Failed to ping backend:", response.status);
        }
      })
      .catch((error) => {
        console.error("Error pinging backend:", error);
      });
  }, []); // Run once on component mount

  return (
    <>
      <Loader />
      <Leva hidden />
      <UI />
      <Canvas shadows camera={{ position: [0, 0, 1], fov: 30 }}>
        <Experience />
      </Canvas>
    </>
  );
}

export default App;
