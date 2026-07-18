import { motion } from "framer-motion";
import { Home, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 text-center">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="space-y-6"
      >
        <div className="text-8xl font-extrabold text-primary/20">404</div>
        <h1 className="text-2xl font-extrabold">Page Not Found</h1>
        <p className="text-muted-foreground text-sm max-w-xs">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="flex gap-3 justify-center">
          <Button variant="outline" className="rounded-2xl" onClick={() => navigate(-1)}>
            <ArrowLeft className="mr-2 h-4 w-4" /> Go Back
          </Button>
          <Button className="rounded-2xl" onClick={() => navigate("/")}>
            <Home className="mr-2 h-4 w-4" /> Dashboard
          </Button>
        </div>
      </motion.div>
    </div>
  );
}
